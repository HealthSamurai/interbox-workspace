/**
 * Source UI — generator wrapper (v0.2 / step 2)
 *
 * Thin adapter around the existing src/gen/ library so the UI server can
 * generate + MLLP-send HL7 messages from a single `/send` route. No subprocess
 * — everything runs in the same Bun process.
 *
 * Profile is loaded once, cached. RNG seed is bumped per call so successive
 * sends look different. Fault injection runs at the requested rate using the
 * existing FAULTS table from src/gen/faults.ts.
 */

import { mkdir, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Rng } from "../src/gen/rng.ts";
import { fakerNames } from "../src/gen/names.ts";
import { parseProfile } from "../src/profile/schema.ts";
import { generateMessage } from "../src/gen/assemble.ts";
import { FAULTS } from "../src/gen/faults.ts";
import { sendOverMllpReliable } from "../src/send/mllp.ts";
import type { Profile } from "../src/profile/schema.ts";
import { DEFAULT_PROFILE } from "../src/paths.ts";

const PROFILE_PATH = process.env.PROFILE_PATH ?? DEFAULT_PROFILE;
let cachedProfile: Profile | null = null;
let seedCounter = Math.floor(Math.random() * 1e9);

async function getProfile(): Promise<Profile> {
  if (!cachedProfile) {
    cachedProfile = parseProfile(await Bun.file(PROFILE_PATH).text());
  }
  return cachedProfile;
}

/** The corpus-learned base profile — sources specialize it (see sources.ts). */
export async function getBaseProfile(): Promise<Profile> {
  return getProfile();
}

export interface SendParams {
  count: number;
  faultRate: number;          // 0..1
  forceType?: string;         // 'ADT^A01' to override profile distribution
  target: { host: string; port: number };
  mock?: boolean;             // if true: simulate ACK locally, no MLLP
  profile?: Profile;          // per-source specialized profile (identity + mix)
}

export interface SendResult {
  generated: number;
  sent: number;            // written to the socket = accepted + rejected + unanswered
  accepted: number;        // ACK AA — the engine confirmed it
  rejected: number;        // ACK AE/AR — the engine saw it and refused
  unanswered: number;      // no answer: timeout, connection error, unreachable
  failed: number;          // rejected + unanswered, for callers that need only "not delivered"
  injectedFaults: number;  // faults we intentionally injected — a subset of sent
  retries: number;         // total redelivery attempts
  durationMs: number;
  types: Record<string, number>;
  ok: boolean;
  error?: string;
}

export async function generateAndSend(p: SendParams): Promise<SendResult> {
  const t0 = performance.now();
  const baseProfile = p.profile ?? (await getProfile());
  const profile: Profile = p.forceType
    ? { ...baseProfile, messageTypes: [[p.forceType, 1]] }
    : baseProfile;

  const seed = ++seedCounter;
  const rng = new Rng(seed);
  const names = fakerNames("en", seed);

  const messages: string[] = [];
  const types: Record<string, number> = {};
  let injectedFaults = 0;

  for (let i = 0; i < p.count; i++) {
    const m = generateMessage(rng, profile, names, i);
    let msg = m.msg;
    if (p.faultRate > 0 && Math.random() < p.faultRate) {
      const fault = FAULTS[Math.floor(Math.random() * FAULTS.length)]!;
      msg = fault.apply(msg);
      injectedFaults++;
    }
    messages.push(msg);
    types[m.type] = (types[m.type] ?? 0) + 1;
  }

  // Mock targets: simulate a small latency + AA ACK without touching the network
  if (p.mock) {
    // realistic-ish: 1–4ms per message, capped at 80ms total
    const simMs = Math.min(80, 1 + messages.length * 0.3);
    await new Promise((r) => setTimeout(r, simMs));
    return {
      generated: messages.length,
      sent: messages.length,
      accepted: messages.length, // a mock target's contract is to simulate acceptance
      rejected: 0,
      unanswered: 0,
      failed: 0,
      retries: 0,
      injectedFaults,
      durationMs: Math.round(performance.now() - t0),
      types,
      ok: true,
    };
  }
  try {
    const result = await sendOverMllpReliable(messages, {
      host: p.target.host,
      port: p.target.port,
      concurrency: Math.min(16, Math.max(2, Math.ceil(p.count / 32))),
      ackTimeoutMs: 3000,
      // For single we want to surface failure immediately; for burst/stream
      // we still want at-least-once delivery so keep modest retries.
      maxRetries: p.count === 1 ? 1 : 3,
      backoffMs: 500,
    });
    return {
      generated: messages.length,
      sent: messages.length,
      accepted: result.acked,
      rejected: result.refused,
      unanswered: result.silent,
      failed: result.failed,
      retries: result.retries,
      injectedFaults,
      durationMs: Math.round(performance.now() - t0),
      types,
      ok: result.failed === 0,
      error: result.failed > 0
        ? `${result.failed}/${messages.length} not delivered after ${result.retries} retries `
          + `(${result.refused} refused, ${result.silent} unanswered)`
        : undefined,
    };
  } catch (e) {
    return {
      generated: messages.length,
      // The send never got off the ground, so nothing was written and nothing
      // was refused — the engine never saw these. Silence, not rejection.
      sent: messages.length,
      accepted: 0,
      rejected: 0,
      unanswered: messages.length,
      failed: messages.length,
      retries: 0,
      injectedFaults,
      durationMs: Math.round(performance.now() - t0),
      types,
      ok: false,
      error: (e as Error)?.message ?? String(e),
    };
  }
}

export interface StreamMessage {
  msg: string;
  type: string;
  injected: boolean; // a fault was deliberately injected into this message
}

/**
 * A per-call message source for STREAM mode. Each call generates one synthetic
 * message (live MSH-7 timestamp) and injects a fault with probability
 * `faultRate`. Profile is cached; rng/names are seeded fresh per source so
 * successive streams differ. Unlike `generateAndSend` this does NO network I/O —
 * the stream loop owns transport (a persistent fire-and-forget MLLP connection),
 * which is what lets it pace far past the per-message-ACK ceiling.
 */
export async function streamGenerator(): Promise<(faultRate: number) => StreamMessage> {
  const profile = await getProfile();
  const seed = ++seedCounter;
  const rng = new Rng(seed);
  const names = fakerNames("en", seed);
  let i = 0;
  return (faultRate: number): StreamMessage => {
    const m = generateMessage(rng, profile, names, i++, { now: new Date() });
    let msg = m.msg;
    let injected = false;
    if (faultRate > 0 && Math.random() < faultRate) {
      msg = FAULTS[Math.floor(Math.random() * FAULTS.length)]!.apply(msg);
      injected = true;
    }
    return { msg, type: m.type, injected };
  };
}

// ── Folder / batch output (files, not MLLP) ─────────────────────────────────
// The batch counterpart of generateAndSend: write raw .hl7 files a folderSource
// can drain (one message per file, CR-separated segments, no MLLP framing).

export interface FolderParams {
  dir: string;
  count: number;
  faultRate: number;    // 0..1
  types?: string[];     // round-robin forced mix; empty = the profile's own mix
  clean?: boolean;      // wipe existing files first (folderSource reads ALL files)
  profile?: Profile;
}
export interface FolderResult {
  written: number;
  dir: string;
  types: Record<string, number>;
  injectedFaults: number;
  ok: boolean;
  error?: string;
}

function badTypes(base: Profile, types?: string[]): string | null {
  if (!types?.length) return null;
  const avail = new Set(base.messageTypes.map(([t]) => t));
  const bad = types.filter((t) => !avail.has(t));
  return bad.length ? `unknown message types: ${bad.join(", ")}` : null;
}

// Round-robin generator over the (optional) forced type list, so every listed
// type appears — evenly — regardless of the profile's own weights.
function forcedGen(base: Profile, types: string[] | null): (faultRate: number) => StreamMessage {
  const seed = ++seedCounter;
  const rng = new Rng(seed);
  const names = fakerNames("en", seed);
  let i = 0;
  return (faultRate: number): StreamMessage => {
    const profile: Profile = types ? { ...base, messageTypes: [[types[i % types.length]!, 1]] } : base;
    const m = generateMessage(rng, profile, names, i++, { now: new Date() });
    let msg = m.msg;
    let injected = false;
    if (faultRate > 0 && Math.random() < faultRate) {
      msg = FAULTS[Math.floor(Math.random() * FAULTS.length)]!.apply(msg);
      injected = true;
    }
    return { msg, type: m.type, injected };
  };
}

export async function generateToFolder(p: FolderParams): Promise<FolderResult> {
  const base = p.profile ?? (await getProfile());
  const bad = badTypes(base, p.types);
  if (bad) return { written: 0, dir: p.dir, types: {}, injectedFaults: 0, ok: false, error: bad };
  const next = forcedGen(base, p.types?.length ? p.types : null);
  const types: Record<string, number> = {};
  let injectedFaults = 0;
  const width = String(Math.max(1, p.count)).length;
  const files: { name: string; msg: string }[] = [];
  for (let i = 0; i < p.count; i++) {
    const m = next(p.faultRate);
    if (m.injected) injectedFaults += 1;
    types[m.type] = (types[m.type] ?? 0) + 1;
    files.push({ name: `msg-${String(i + 1).padStart(width, "0")}-${m.type.replace(/\^/g, "_")}.hl7`, msg: m.msg });
  }
  try {
    await mkdir(p.dir, { recursive: true });
    if (p.clean) for (const f of await readdir(p.dir)) await rm(join(p.dir, f), { force: true });
    for (const f of files) await Bun.write(join(p.dir, f.name), f.msg);
    return { written: files.length, dir: p.dir, types, injectedFaults, ok: true };
  } catch (e) {
    return { written: 0, dir: p.dir, types, injectedFaults, ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

/** Streaming folder writer: trickle one .hl7 per tick at a fixed rate until stopped. */
class FolderStreamer {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private next: ((faultRate: number) => StreamMessage) | null = null;
  private seq = 0;
  written = 0;
  dir = "";
  rate = 2;
  faultRate = 0;

  async start(o: { dir: string; rate: number; faultRate: number; types?: string[]; profile?: Profile }): Promise<{ ok: boolean; error?: string }> {
    if (this.running) return { ok: true };
    const base = o.profile ?? (await getProfile());
    const bad = badTypes(base, o.types);
    if (bad) return { ok: false, error: bad };
    await mkdir(o.dir, { recursive: true });
    this.dir = o.dir;
    this.rate = Math.max(0.1, o.rate);
    this.faultRate = Math.max(0, Math.min(1, o.faultRate));
    this.written = 0;
    this.next = forcedGen(base, o.types?.length ? o.types : null);
    this.running = true;
    const tick = async (): Promise<void> => {
      if (!this.running || !this.next) return;
      const m = this.next(this.faultRate);
      const name = `stream-${String(++this.seq).padStart(6, "0")}-${m.type.replace(/\^/g, "_")}.hl7`;
      try { await Bun.write(join(this.dir, name), m.msg); this.written += 1; } catch { /* keep going */ }
      if (this.running) this.timer = setTimeout(() => void tick(), Math.max(20, 1000 / this.rate));
    };
    void tick();
    return { ok: true };
  }
  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  state(): { running: boolean; written: number; dir: string; rate: number } {
    return { running: this.running, written: this.written, dir: this.dir, rate: this.rate };
  }
}
export const folderStreamer = new FolderStreamer();
