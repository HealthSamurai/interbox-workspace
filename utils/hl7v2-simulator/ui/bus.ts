/**
 * Source UI — shared SSE event bus.
 *
 * One pub/sub channel for everything the UI streams: the classic single-stream
 * events (shape unchanged — `sourceId` is additive, old clients ignore it) and
 * per-source actor events for the topology view. Extracted from stream.ts so
 * N actors and the classic adapter publish to the same /events pipe.
 */

/**
 * Two axes, deliberately not mixed.
 *
 *   delivery   sent = accepted + rejected + unanswered
 *   content    malformed — messages we deliberately corrupted
 *
 * `sent` counts messages the sender accounted for — on the retrying path a
 * message is counted once even when it was written more than once. The receiver
 * then said yes (AA), said no (AE/AR), or has not said anything yet.
 * `malformed` is orthogonal to all three: a corrupted message is already inside
 * `sent`, and can be accepted or refused like any other.
 */
export interface ActorCounters {
  sent: number;
  accepted: number;
  rejected: number;
  unanswered: number;
  malformed: number;
}

export interface ActorStateSnapshot {
  running: boolean;
  rate: number;
  faultRate: number;
  counters: ActorCounters;
}

export type BusEvent =
  | { type: "state"; sourceId?: string; state: ActorStateSnapshot }
  | { type: "tick"; sourceId?: string; malformed: boolean; msgType: string; counters: ActorCounters }
  | { type: "error"; sourceId?: string; error: string }
  | { type: "sources"; sources: unknown[] }; // registry snapshot for the topology view

type Subscriber = (event: BusEvent) => void;
const subscribers = new Set<Subscriber>();

export function publish(event: BusEvent): void {
  for (const sub of subscribers) {
    try { sub(event); } catch { /* dead connection — ignore */ }
  }
}

/** Subscribe; `hello` events (initial snapshots) are the caller's concern. */
export function subscribeBus(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
