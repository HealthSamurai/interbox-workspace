/**
 * Source UI — classic single-stream adapter (v0.5)
 *
 * The old singleton stream now delegates to one SourceActor (see actor.ts) so
 * the Classic page keeps its exact API and event shapes while the same actor
 * machinery also powers N independent per-source streams (sources.ts). The
 * classic actor publishes without a distinguishing identity of its own —
 * its events carry sourceId "classic", which old clients simply ignore.
 */

import { SourceActor } from "./actor.ts";
import { getBaseProfile } from "./generator.ts";
import { publish, subscribeBus, type BusEvent } from "./bus.ts";

let target = { host: "127.0.0.1", port: 2575, label: "Engine A", mock: false };

const classic = new SourceActor("classic", getBaseProfile, () => target);

export function setTarget(host: string, port: number, label = "", mock = false): void {
  target = { host, port, label: label || `${host}:${port}`, mock };
  classic.retarget(); // restart the current leg against the new target
}

export function getTarget(): { host: string; port: number; label: string; mock: boolean } {
  return { ...target };
}

export function startStream(rate: number, faultRate: number): void {
  classic.start(rate, faultRate);
}

export function stopStream(): void {
  classic.stop();
}

export function updateStream(p: { rate?: number; faultRate?: number }): void {
  classic.update(p);
}

export function bumpExternalCounters(sent: number, accepted: number, rejected: number, malformed: number): void {
  classic.bump(sent, accepted, rejected, malformed);
}

export function subscribe(fn: (event: BusEvent) => void): () => void {
  const unsub = subscribeBus(fn);
  fn({ type: "state", sourceId: "classic", state: classic.snapshot() }); // initial snapshot
  return unsub;
}

export function getState(): ReturnType<SourceActor["snapshot"]> {
  return classic.snapshot();
}

export { publish };
