/**
 * Source UI — SourceRegistry: the simulated upstream senders.
 *
 * A Source is "who": a sender identity (name → MSH-4, type → MSH-3 + message
 * mix + its own MRN pool) plus behavior (stream rate, fault rate, optional own
 * target port). Identity is injected by SPECIALIZING the corpus profile — the
 * grammar samples MSH-3/4 and the assigning authority from profile catalogs,
 * so a clone with single-entry catalogs gives a source its identity with zero
 * changes to the generation core.
 *
 * The registry persists to a local JSON file (a prepared demo setup must not
 * evaporate on restart) and owns one SourceActor per source.
 */

import type { Profile } from "../src/profile/schema.ts";
import { SourceActor, type ActorTarget } from "./actor.ts";
import type { ActorCounters } from "./bus.ts";
import { getBaseProfile } from "./generator.ts";
import { publish } from "./bus.ts";

export type SourceType = "lab" | "clinic" | "hospital" | "pharmacy";

export interface SourceDef {
  id: string;           // slug of name — stable key
  name: string;         // display + MSH-4 (CAPS ASCII)
  type: SourceType;
  rate: number;         // stream msg/s
  faultRate: number;    // 0..1
  targetPort?: number;  // per-source override; unset → global target
  // Hand-picked message types (equal weights). Unset → the type preset's mix.
  msgTypes?: string[];
}

/** Message types the grammar can build (events the profile/builders support). */
export const ALLOWED_MSG_TYPES = [
  "ORU^R01", "ORM^O01",
  "ADT^A01", "ADT^A03", "ADT^A08",
  "SIU^S12",
  "MDM^T02", "MDM^T07", "MDM^T11",
  "RDE^O01", "RDE^O11", "RAS^O17",
] as const;

// MSH-3 (sending application) + message mix per source type. Labs push results;
// clinics push visits + scheduling; hospitals are ADT-heavy with some results.
const TYPE_PRESETS: Record<SourceType, { app: string; mix: [string, number][] }> = {
  lab: { app: "LAB_IF", mix: [["ORU^R01", 0.75], ["ORM^O01", 0.1], ["ADT^A08", 0.15]] },
  clinic: { app: "CLINIC_EHR", mix: [["ADT^A08", 0.55], ["SIU^S12", 0.45]] },
  hospital: { app: "HOSP_ADT", mix: [["ADT^A01", 0.3], ["ADT^A03", 0.2], ["ADT^A08", 0.2], ["ORU^R01", 0.2], ["MDM^T02", 0.1]] },
  pharmacy: { app: "PHARM_SYS", mix: [["RDE^O11", 0.5], ["RAS^O17", 0.35], ["ADT^A08", 0.15]] },
};

/** HL7-style sender name: CAPS, ASCII, single spaces. */
export function normalizeName(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

export function slugOf(name: string): string {
  return normalizeName(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// Initials for the per-source MRN prefix: "SUNRISE LAB" → "SL".
function initialsOf(name: string): string {
  const parts = normalizeName(name).split(" ").filter(Boolean);
  return (parts.map((p) => p[0]).join("") || "SRC").slice(0, 3);
}

/**
 * Identity injection: specialize the corpus profile for one source. Single-entry
 * catalogs pin MSH-3/MSH-4/assigning authority; the mix comes from the type
 * preset; the MRN format gets a per-source prefix (own patient-id pool).
 */
export function profileFor(base: Profile, def: SourceDef): Profile {
  const preset = TYPE_PRESETS[def.type];
  const facility = normalizeName(def.name);
  const aa = `${slugOf(def.name).toUpperCase().replace(/-/g, "_")}_MRN`;
  // Hand-picked types win over the preset mix (equal weights across picks).
  const mix: [string, number][] = def.msgTypes?.length
    ? def.msgTypes.map((t) => [t, 1 / def.msgTypes!.length])
    : preset.mix;
  return {
    ...base,
    messageTypes: mix,
    catalogs: {
      ...base.catalogs,
      app: [[preset.app, 1]],
      facility: [[facility, 1]],
      assigningAuthority: [[aa, 1]],
    },
    idFormats: { ...base.idFormats, mrn: `${initialsOf(def.name)}########` },
  };
}

export interface SourceView extends SourceDef {
  running: boolean;
  counters: ActorCounters;
}

export class SourceRegistry {
  private readonly path: string;
  private readonly globalTarget: () => ActorTarget;
  private readonly defs = new Map<string, SourceDef>();
  private readonly actors = new Map<string, SourceActor>();

  constructor(path: string, globalTarget: () => ActorTarget) {
    this.path = path;
    this.globalTarget = globalTarget;
  }

  /** Load persisted sources, or seed the three defaults on first boot. */
  async init(): Promise<void> {
    let defs: SourceDef[] | null = null;
    try {
      const raw = await Bun.file(this.path).json() as SourceDef[];
      if (Array.isArray(raw) && raw.every((d) => d && typeof d.id === "string")) defs = raw;
    } catch { /* no file yet — seed below */ }
    if (!defs) {
      defs = [
        { id: "memorial-lab", name: "MEMORIAL LAB", type: "lab", rate: 2.0, faultRate: 0.05 },
        { id: "cedarview-clinic", name: "CEDARVIEW CLINIC", type: "clinic", rate: 0.5, faultRate: 0.05 },
        { id: "st-marys-hospital", name: "ST MARYS HOSPITAL", type: "hospital", rate: 1.0, faultRate: 0.05 },
      ];
      await this.saveDefs(defs);
    }
    for (const def of defs) this.mount(def);
  }

  private async saveDefs(defs?: SourceDef[]): Promise<void> {
    const list = defs ?? [...this.defs.values()];
    await Bun.write(this.path, JSON.stringify(list, null, 2));
  }

  private mount(def: SourceDef): void {
    this.defs.set(def.id, def);
    const actor = new SourceActor(
      def.id,
      async () => profileFor(await getBaseProfile(), this.defs.get(def.id) ?? def),
      // Per-leg resolution: a port override (or a live global-target switch)
      // applies on the next leg without recreating the actor.
      () => {
        const d = this.defs.get(def.id);
        const g = this.globalTarget();
        return d?.targetPort ? { host: "127.0.0.1", port: d.targetPort } : g;
      },
    );
    this.actors.set(def.id, actor);
  }

  list(): SourceView[] {
    return [...this.defs.values()].map((d) => {
      const a = this.actors.get(d.id)!;
      const s = a.snapshot();
      return { ...d, running: s.running, counters: s.counters };
    });
  }

  get(id: string): { def: SourceDef; actor: SourceActor } | undefined {
    const def = this.defs.get(id);
    const actor = this.actors.get(id);
    return def && actor ? { def, actor } : undefined;
  }

  profileOf(id: string): Promise<Profile> | undefined {
    const def = this.defs.get(id);
    return def ? getBaseProfile().then((b) => profileFor(b, def)) : undefined;
  }

  targetOf(id: string): ActorTarget | undefined {
    const def = this.defs.get(id);
    if (!def) return undefined;
    return def.targetPort ? { host: "127.0.0.1", port: def.targetPort } : this.globalTarget();
  }

  async create(input: { name: string; type: SourceType; rate?: number; faultRate?: number; targetPort?: number; msgTypes?: string[] }): Promise<SourceDef> {
    const name = normalizeName(input.name);
    if (!name) throw new Error("name is required");
    if (!TYPE_PRESETS[input.type]) throw new Error(`unknown type "${input.type}" (${Object.keys(TYPE_PRESETS).join(" | ")})`);
    const id = slugOf(name);
    if (this.defs.has(id)) throw new Error(`source "${id}" already exists`);
    const def: SourceDef = {
      id,
      name,
      type: input.type,
      rate: clampRate(input.rate ?? 1.0),
      faultRate: clamp01(input.faultRate ?? 0),
      ...(input.targetPort ? { targetPort: validPort(input.targetPort) } : {}),
      ...(input.msgTypes ? { msgTypes: validMsgTypes(input.msgTypes) } : {}),
    };
    this.mount(def);
    await this.saveDefs();
    this.publishSources();
    return def;
  }

  async update(id: string, patch: Partial<Pick<SourceDef, "rate" | "faultRate" | "targetPort" | "msgTypes">> & { clearTargetPort?: boolean }): Promise<SourceDef> {
    const entry = this.get(id);
    if (!entry) throw new Error(`unknown source "${id}"`);
    const def = entry.def;
    if (typeof patch.rate === "number") def.rate = clampRate(patch.rate);
    if (typeof patch.faultRate === "number") def.faultRate = clamp01(patch.faultRate);
    if (typeof patch.targetPort === "number") def.targetPort = validPort(patch.targetPort);
    if (patch.clearTargetPort) delete def.targetPort;
    if (Array.isArray(patch.msgTypes)) {
      // Empty selection = back to the type preset. The actor's generator is
      // profile-backed lazily per leg, so restart the leg to pick up the mix.
      if (patch.msgTypes.length === 0) delete def.msgTypes;
      else def.msgTypes = validMsgTypes(patch.msgTypes);
      entry.actor.regen();
    }
    entry.actor.update({ rate: def.rate, faultRate: def.faultRate }); // live-applies
    if (typeof patch.targetPort === "number" || patch.clearTargetPort) entry.actor.retarget();
    await this.saveDefs();
    this.publishSources();
    return def;
  }

  async remove(id: string): Promise<void> {
    const entry = this.get(id);
    if (!entry) throw new Error(`unknown source "${id}"`);
    entry.actor.stop();
    this.defs.delete(id);
    this.actors.delete(id);
    await this.saveDefs();
    this.publishSources();
  }

  /** Every actor restarts its leg — used when the GLOBAL target switches. */
  retargetAll(): void {
    for (const a of this.actors.values()) a.retarget();
  }

  /** Start (at each source's own rate) or stop every source at once. */
  streamAll(action: "start" | "stop"): void {
    for (const [id, actor] of this.actors) {
      if (action === "stop") actor.stop();
      else { const d = this.defs.get(id); actor.start(d?.rate, d?.faultRate); }
    }
    this.publishSources();
  }

  publishSources(): void {
    publish({ type: "sources", sources: this.list() });
  }
}

function validMsgTypes(list: string[]): string[] {
  const ok = list.filter((t): t is (typeof ALLOWED_MSG_TYPES)[number] => (ALLOWED_MSG_TYPES as readonly string[]).includes(t));
  if (ok.length === 0) throw new Error(`no valid message types in [${list.join(", ")}]`);
  return [...new Set(ok)];
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
// Ceiling is a safety clamp, not the measured limit — see the load section in
// the simulator spec. Overridable for load rigs via MAX_STREAM_RATE.
const MAX_RATE = Number(process.env.MAX_STREAM_RATE ?? 1000);
const clampRate = (n: number): number => Math.max(0.1, Math.min(MAX_RATE, n));
function validPort(n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`invalid port ${n}`);
  return n;
}
