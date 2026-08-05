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

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseProfile } from "../src/profile/schema.ts";
import { makeGenerator, type StreamMessage } from "../src/gen/stream.ts";
import { sendOverMllpReliable } from "../src/send/mllp.ts";
import type { Profile } from "../src/profile/schema.ts";

export type { StreamMessage };
import { cleanExports, DEFAULT_PROFILE, safeExportDir } from "../src/paths.ts";

const PROFILE_PATH = process.env.PROFILE_PATH ?? DEFAULT_PROFILE;
// Ceiling for the trickle-to-folder stream, which otherwise runs until the
// process dies — it outlives the browser tab that started it.
const MAX_STREAM_FILES = Number(process.env.MAX_STREAM_FILES ?? 100_000);
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

  const next = makeGenerator({ profile, seed: ++seedCounter });

  const messages: string[] = [];
  const types: Record<string, number> = {};
  let injectedFaults = 0;

  for (let i = 0; i < p.count; i++) {
    const m = next(p.faultRate);
    if (m.injected) injectedFaults++;
    messages.push(m.msg);
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

// ── Folder / batch output (files, not MLLP) ─────────────────────────────────
// The batch counterpart of generateAndSend: write raw .hl7 files a folderSource
// can drain (one message per file, CR-separated segments, no MLLP framing).

export interface FolderParams {
  dir: string;
  count: number;
  faultRate: number;    // 0..1
  types?: string[];     // round-robin forced mix; empty = the profile's own mix
  clean?: boolean;      // remove our own .hl7 files first (folderSource reads ALL files)
  profile?: Profile;
  seed?: number;        // reproduce a previous export; omitted = a fresh one
}
export interface FolderResult {
  written: number;
  dir: string;
  types: Record<string, number>;
  injectedFaults: number;
  /** The seed actually used — pass it back to regenerate this exact batch. */
  seed: number;
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
//
// `seed` is accepted so an export can be reproduced; without one it advances a
// process counter, which keeps successive exports different but still puts the
// seed on the record (the result reports it back).
function forcedGen(base: Profile, types: string[] | null, seed: number): (faultRate: number) => StreamMessage {
  return makeGenerator({ profile: base, seed, types, liveTime: true });
}

export async function generateToFolder(p: FolderParams): Promise<FolderResult> {
  const base = p.profile ?? (await getProfile());
  const bad = badTypes(base, p.types);
  if (bad) return { written: 0, dir: p.dir, types: {}, injectedFaults: 0, seed: 0, ok: false, error: bad };
  let dir: string;
  try {
    dir = safeExportDir(p.dir);
  } catch (e) {
    return { written: 0, dir: p.dir, types: {}, injectedFaults: 0, seed: 0, ok: false, error: (e as Error).message };
  }
  const seed = p.seed ?? ++seedCounter;
  const next = forcedGen(base, p.types?.length ? p.types : null, seed);
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
    await mkdir(dir, { recursive: true });
    // Only our own output. The previous `rm` over every entry took out unrelated
    // files, and — without `recursive` — threw on the first subdirectory, so it
    // deleted whatever sorted ahead of that and then reported written: 0. Worst
    // of both: destructive AND failed.
    if (p.clean) await cleanExports(dir);
    for (const f of files) await Bun.write(join(dir, f.name), f.msg);
    return { written: files.length, dir, types, injectedFaults, seed, ok: true };
  } catch (e) {
    return { written: 0, dir, types, injectedFaults, seed, ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

/** Streaming folder writer: trickle one .hl7 per tick at a fixed rate until stopped. */
class FolderStreamer {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private next: ((faultRate: number) => StreamMessage) | null = null;
  private seq = 0;
  // Bumped on every start/stop. A tick that awaits Bun.write across a stop() and
  // a fresh start() would otherwise carry on beside the new run's tick chain —
  // two loops writing, with `timer` tracking only one of them, so stop() could
  // never cancel both.
  private generation = 0;
  private lastError: string | null = null;
  written = 0;
  dir = "";
  rate = 2;
  faultRate = 0;

  async start(o: { dir: string; rate: number; faultRate: number; types?: string[]; profile?: Profile; seed?: number }): Promise<{ ok: boolean; error?: string }> {
    if (this.running) return { ok: false, error: `already streaming to ${this.dir}` };
    const base = o.profile ?? (await getProfile());
    const bad = badTypes(base, o.types);
    if (bad) return { ok: false, error: bad };
    let dir: string;
    try {
      dir = safeExportDir(o.dir);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    await mkdir(dir, { recursive: true });
    this.dir = dir;
    this.rate = Math.max(0.1, o.rate);
    this.faultRate = Math.max(0, Math.min(1, o.faultRate));
    this.written = 0;
    this.lastError = null;
    this.next = forcedGen(base, o.types?.length ? o.types : null, o.seed ?? ++seedCounter);
    this.running = true;
    const mine = ++this.generation;
    const tick = async (): Promise<void> => {
      if (this.generation !== mine || !this.running || !this.next) return;
      const m = this.next(this.faultRate);
      const name = `stream-${String(++this.seq).padStart(6, "0")}-${m.type.replace(/\^/g, "_")}.hl7`;
      try {
        await Bun.write(join(this.dir, name), m.msg);
        this.written += 1;
      } catch (e) {
        // A full disk or a deleted directory used to leave the stream reporting
        // running:true with a frozen count and no error anywhere. Stop and say why.
        this.lastError = (e as Error)?.message ?? String(e);
        this.stop();
        return;
      }
      if (this.written >= MAX_STREAM_FILES) {
        this.lastError = `stopped at the ${MAX_STREAM_FILES}-file limit (raise MAX_STREAM_FILES)`;
        this.stop();
        return;
      }
      if (this.generation === mine && this.running) {
        this.timer = setTimeout(() => void tick(), Math.max(20, 1000 / this.rate));
      }
    };
    void tick();
    return { ok: true };
  }
  stop(): void {
    this.running = false;
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  state(): { running: boolean; written: number; dir: string; rate: number; error: string | null } {
    return { running: this.running, written: this.written, dir: this.dir, rate: this.rate, error: this.lastError };
  }
}
export const folderStreamer = new FolderStreamer();
