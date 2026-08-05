/**
 * Source UI — SourceActor: one independent upstream sender.
 *
 * The former stream.ts singleton (one state + one Poisson loop + one MLLP
 * connection) generalized into a class, so N actors — one per simulated
 * sender — run concurrently in this process, each with its own pacing loop,
 * its own connection (error isolation), its own Rng (per-source determinism)
 * and its own counters. A stream is 99.9% waiting, so the event loop hosts
 * many of them the way a web server hosts many sockets.
 */

import { makeGenerator, type StreamMessage } from "../src/gen/stream.ts";
import { streamOverMllp } from "../src/send/mllp.ts";
import type { Profile } from "../src/profile/schema.ts";
import { publish, type ActorStateSnapshot, type ActorCounters } from "./bus.ts";

export interface ActorTarget { host: string; port: number; mock?: boolean }

// Exponential inter-arrival delay for a Poisson process with the given rate.
function poissonDelayMs(rate: number): number {
  return (-Math.log(1 - Math.random()) / rate) * 1000;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class SourceActor {
  readonly id: string;
  /** Lazy so construction stays sync; resolved once on first use. */
  private readonly profileFn: () => Promise<Profile>;
  /** Read per leg — a live target/port change applies on the next leg. */
  private readonly targetFn: () => ActorTarget;

  private running = false;
  private rate = 1.0;
  private faultRate = 0;
  // Two independent axes, deliberately not mixed.
  //
  //   delivery   sent = accepted + rejected + unanswered
  //   content    malformed — a fault we injected, orthogonal to the above
  //
  // `unanswered` is derived on read rather than stored, so the delivery identity
  // needs no reconciliation. A message still in flight counts as unanswered,
  // which is accurate: nothing has come back for it yet.
  //
  // The clamp in view() is a guard, not a proof. An engine using enhanced
  // acknowledgement answers twice per message — a commit ACK and an application
  // ACK — and nothing here correlates MSA-2 back to the message that caused it,
  // so accepted + rejected can exceed sent. That shows up as unanswered pinned
  // at zero rather than as a negative number.
  private readonly counters = { sent: 0, accepted: 0, rejected: 0, malformed: 0 };

  private runAc: AbortController | null = null; // whole stream
  private legAc: AbortController | null = null; // current target leg
  private runToken: object | null = null; // identifies the live run (see supervise)
  private nextIndex = 0; // identifier index, carried across regenerations
  private gen: ((faultRate: number) => StreamMessage) | null = null;

  constructor(id: string, profileFn: () => Promise<Profile>, targetFn: () => ActorTarget) {
    this.id = id;
    this.profileFn = profileFn;
    this.targetFn = targetFn;
  }

  /** Counters as published: `unanswered` derived, so `sent` always balances. */
  private view(): ActorCounters {
    const c = this.counters;
    return { ...c, unanswered: Math.max(0, c.sent - c.accepted - c.rejected) };
  }

  snapshot(): ActorStateSnapshot {
    return { running: this.running, rate: this.rate, faultRate: this.faultRate, counters: this.view() };
  }

  /**
   * One synthetic message per call — own seeded Rng/names, live MSH-7 timestamp.
   *
   * `startIndex` advances across regenerations rather than resetting to 0.
   * Identifiers are index-derived, so restarting a source used to replay the
   * same control/placer/visit numbers it had already sent — which is exactly
   * what a receiver's dedup is meant to catch.
   */
  private async makeGen(): Promise<(faultRate: number) => StreamMessage> {
    const profile = await this.profileFn();
    return makeGenerator({
      profile,
      seed: Math.floor(Math.random() * 1e9),
      liveTime: true,
      startIndex: this.nextIndex,
    });
  }

  private lastTickAt = 0;
  private onMessage(m: StreamMessage): void {
    this.counters.sent += 1;
    this.nextIndex += 1;
    if (m.injected) this.counters.malformed += 1;
    // High-rate protection: at 500+ msg/s a tick per message would flood SSE
    // clients. Cap published ticks to ~20/s per source; counters ride on each
    // tick, so nothing is lost — the UI just animates a sample. Injected-fault
    // ticks always go through (the red pulse must not be sampled away).
    const now = performance.now();
    if (!m.injected && now - this.lastTickAt < 50) return;
    this.lastTickAt = now;
    publish({ type: "tick", sourceId: this.id, malformed: m.injected, msgType: m.type, counters: this.view() });
  }

  private lastAckPublishAt = 0;
  private ackFlush: ReturnType<typeof setTimeout> | null = null;

  /**
   * One ACK came back. Classification only — the stream never waited for it.
   *
   * Publishing is sampled to ~20/s for the same reason ticks are: at 600 msg/s
   * a publish per ACK is a publish per message, and every subscriber answers it.
   * A trailing flush fires after the window so the last ACKs of a burst are never
   * left unpublished — sampling may delay the counters, never strand them.
   */
  private onAck(code: string | undefined): void {
    if (code === "AA") this.counters.accepted += 1;
    else this.counters.rejected += 1; // AE, AR, or a response carrying no MSA-1

    const now = performance.now();
    if (now - this.lastAckPublishAt >= 50) {
      this.lastAckPublishAt = now;
      if (this.ackFlush) { clearTimeout(this.ackFlush); this.ackFlush = null; }
      publish({ type: "state", sourceId: this.id, state: this.snapshot() });
      return;
    }
    if (!this.ackFlush) {
      this.ackFlush = setTimeout(() => {
        this.ackFlush = null;
        this.lastAckPublishAt = performance.now();
        publish({ type: "state", sourceId: this.id, state: this.snapshot() });
      }, 60);
    }
  }

  // Real MLLP leg: persistent connection, absolute-deadline pacing.
  private async runReal(signal: AbortSignal, t: ActorTarget): Promise<void> {
    const gen = this.gen ?? (this.gen = await this.makeGen());
    let last: StreamMessage = { msg: "", type: "", injected: false };
    await streamOverMllp({
      host: t.host,
      port: t.port,
      reconnect: true, // survive an engine restart mid-demo
      signal,
      next: () => { if (signal.aborted) return null; last = gen(this.faultRate); return last.msg; },
      gapMs: () => poissonDelayMs(this.rate), // live rate
      onSent: () => this.onMessage(last),
      onAck: (code) => this.onAck(code),
    });
  }

  // Mock leg: no network — same pacing, simulated dispatch.
  private async runMock(signal: AbortSignal): Promise<void> {
    const gen = this.gen ?? (this.gen = await this.makeGen());
    let nextAt = performance.now();
    while (!signal.aborted) {
      this.onMessage(gen(this.faultRate));
      this.onAck("AA"); // a mock target's contract is to simulate acceptance
      nextAt += poissonDelayMs(this.rate);
      const now = performance.now();
      if (nextAt < now - 250) nextAt = now; // long stall — resync, don't burst
      const wait = nextAt - now;
      if (wait > 0 && !signal.aborted) await sleep(wait);
    }
  }

  // Supervisor: runs the active leg; restarts it on retarget; exits on stop.
  //
  // `token` identifies this run. stop() flips `running` synchronously, but the
  // loop can still be parked in an uncancellable sleep for up to one
  // inter-arrival gap — seconds at low rates. A start() inside that window
  // legitimately begins a new run; when the old one finally unwinds, its tail
  // must not clobber the new run's state. Without the token check it did, and
  // stop() then early-returned on !running forever: a source that could not be
  // stopped short of restarting the process.
  private async supervise(signal: AbortSignal, token: object): Promise<void> {
    while (!signal.aborted) {
      const leg = new AbortController();
      this.legAc = leg;
      const onAbort = (): void => leg.abort();
      signal.addEventListener("abort", onAbort);
      const t = this.targetFn();
      try {
        if (t.mock) await this.runMock(leg.signal);
        else await this.runReal(leg.signal, t);
      } catch (e) {
        if (!leg.signal.aborted) {
          publish({ type: "error", sourceId: this.id, error: (e as Error)?.message ?? String(e) });
          if (!signal.aborted) await sleep(500); // don't hot-spin on a hard failure
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    }
    if (this.runToken !== token) return; // superseded by a newer start()
    this.running = false;
    publish({ type: "state", sourceId: this.id, state: this.snapshot() });
  }

  start(rate?: number, faultRate?: number): void {
    if (typeof rate === "number") this.rate = Math.max(0.1, rate);
    if (typeof faultRate === "number") this.faultRate = Math.max(0, Math.min(1, faultRate));
    if (this.running) return; // idempotent
    this.running = true;
    this.runAc = new AbortController();
    const token = {};
    this.runToken = token;
    publish({ type: "state", sourceId: this.id, state: this.snapshot() });
    void this.supervise(this.runAc.signal, token);
  }

  stop(): void {
    if (!this.running) return;
    // Flip synchronously so the API response / UI reflect the stop immediately;
    // the supervisor's own exit publish is then an idempotent no-op. Without
    // this the state stayed running=true until the loop unwound, which made
    // the Stop button look unresponsive.
    this.running = false;
    this.runAc?.abort();
    publish({ type: "state", sourceId: this.id, state: this.snapshot() });
  }

  update(p: { rate?: number; faultRate?: number }): void {
    if (typeof p.rate === "number") this.rate = Math.max(0.1, p.rate);
    if (typeof p.faultRate === "number") this.faultRate = Math.max(0, Math.min(1, p.faultRate));
    publish({ type: "state", sourceId: this.id, state: this.snapshot() });
  }

  /** Restart the current leg (e.g. after a target/port change). */
  retarget(): void {
    if (this.running) this.legAc?.abort();
  }

  /** Profile changed (e.g. hand-picked message types) — rebuild the generator
   *  on the next leg and restart the current one so the change applies live. */
  regen(): void {
    this.gen = null;
    this.retarget();
  }

  /** Fold externally-produced traffic (single/burst sends) into the counters.
   *  `sent` is passed explicitly rather than inferred, so a send that was never
   *  answered stays visible as unanswered instead of being forced to zero. */
  bump(sent: number, accepted: number, rejected: number, malformed: number): void {
    this.counters.sent += sent;
    this.counters.accepted += accepted;
    this.counters.rejected += rejected;
    this.counters.malformed += malformed;
    publish({ type: "state", sourceId: this.id, state: this.snapshot() });
  }

  get isRunning(): boolean {
    return this.running;
  }
}
