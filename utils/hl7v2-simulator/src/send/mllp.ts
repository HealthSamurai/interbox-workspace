import * as net from "node:net";

// MLLP minimal lower layer: SB + UTF-8 payload + EB CR.
const SB = 0x0b;
/** Cap on unframed response bytes held per socket. An ACK is a few hundred. */
const ACK_BUF_MAX = 64 * 1024;
/** Grace before closing a leg, so ACKs already on the wire still land. */
const ACK_LINGER_MS = 300;
const EB = 0x1c;
const CR = 0x0d;

/** Wrap a raw HL7v2 message in an MLLP frame. */
export function mllpFrame(payload: string): Buffer {
  return Buffer.concat([
    Buffer.from([SB]),
    Buffer.from(payload, "utf8"),
    Buffer.from([EB, CR]),
  ]);
}

export interface MllpOpts {
  host?: string;
  port?: number;
  concurrency?: number;
}

/**
 * Open an MLLP socket. `onAck` receives each ACK's MSA-1 code (AA / AE / AR) as
 * it arrives; without it the responses are drained and dropped.
 *
 * Reading is not waiting. The sender never blocks on a response — it keeps
 * writing at the requested rate while replies are framed and classified on the
 * data event. A generator that discards ACKs cannot tell "delivered" from
 * "refused", which is the one thing the receiver is telling it.
 */
function open(host: string, port: number, onAck?: (code: string | undefined) => void): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port }, () => {
      sock.removeListener("error", reject);
      resolve(sock);
    });
    sock.setNoDelay(true);
    sock.once("error", reject);
    if (!onAck) {
      sock.on("data", () => {}); // drain, don't block
      return;
    }
    // Responses arrive framed and may split or coalesce across chunks: buffer,
    // then take every complete <SB>…<EB> block that has landed.
    let buf = Buffer.alloc(0);
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const eb = buf.indexOf(EB);
        if (eb < 0) break;
        const sb = buf.indexOf(SB);
        if (sb >= 0 && sb < eb) onAck(ackCode(buf.subarray(sb + 1, eb).toString("utf8")));
        buf = buf.subarray(eb + 1);
      }
      // A peer that never sends an end-block would grow this without limit —
      // reachable by ordinary misconfiguration, e.g. a source aimed at an HTTP
      // port, where every message draws a reply containing no MLLP framing.
      // Report the garbage rather than swallowing it, then drop what cannot be
      // a frame: keep from the last start-block, or nothing if there is none.
      if (buf.length > ACK_BUF_MAX) {
        onAck(undefined);
        const sb = buf.lastIndexOf(SB);
        buf = sb >= 0 ? buf.subarray(sb) : Buffer.alloc(0);
      }
    });
  });
}

/**
 * Send messages over MLLP via a small pool of persistent connections.
 * Returns how many were written. The engine assigns status itself.
 */
export async function sendOverMllp(messages: string[], opts: MllpOpts = {}): Promise<number> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 2575;
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 8, messages.length || 1));
  // allSettled + an explicit teardown: with Promise.all, one failed connect (or
  // one socket erroring mid-write) rejected the aggregate and left every sibling
  // socket open and unreferenced. Worse, `open` removes its own error listener
  // once connected, so a later error on a leaked socket was an unhandled 'error'
  // event — which takes the process down.
  const opened = await Promise.allSettled(
    Array.from({ length: concurrency }, () => open(host, port)),
  );
  const socks = opened.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  if (socks.length === 0) {
    const why = opened.find((r) => r.status === "rejected");
    throw why?.status === "rejected" ? why.reason : new Error(`could not connect to ${host}:${port}`);
  }
  let sent = 0;
  try {
    const results = await Promise.allSettled(
      socks.map((sock, k) =>
        new Promise<void>((resolve, reject) => {
          sock.once("error", reject);
          let i = k;
          const writeNext = (): void => {
            if (i >= messages.length) {
              sock.end();
              resolve();
              return;
            }
            const buf = mllpFrame(messages[i]!);
            i += socks.length;
            sent++;
            if (sock.write(buf)) process.nextTick(writeNext);
            else sock.once("drain", writeNext);
          };
          writeNext();
        }),
      ),
    );
    const failed = results.find((r) => r.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    return sent;
  } finally {
    // Keep a listener attached: destroying a socket can still surface an error,
    // and an unhandled 'error' event is fatal.
    for (const sock of socks) {
      sock.on("error", () => {});
      sock.destroy();
    }
  }
}

/** Parse the ACK code (MSA-1: AA/AE/AR) from an HL7 ACK message. */
export function ackCode(ack: string): string | undefined {
  const msa = ack.split("\r").find((s) => s.startsWith("MSA|"));
  return msa ? msa.split("|")[1] : undefined;
}

/** Send one message and await its MLLP ACK. Resolves the MSA-1 code, or
 *  undefined when nothing came back — silence is not refusal. */
function deliverOne(host: string, port: number, msg: string, ackTimeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (code: string | undefined): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(code);
    };
    const timer = setTimeout(() => finish(undefined), ackTimeoutMs);
    sock.setNoDelay(true);
    sock.on("connect", () => sock.write(mllpFrame(msg)));
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const eb = buf.indexOf(EB);
      if (eb >= 0) {
        const sb = buf.indexOf(SB);
        finish(ackCode(buf.subarray(sb + 1, eb).toString("utf8")));
      }
    });
    sock.on("error", () => finish(undefined));
  });
}

export interface ReliableOpts extends MllpOpts {
  ackTimeoutMs?: number;
  maxRetries?: number;
  backoffMs?: number;
}

export interface ReliableResult {
  acked: number;
  /** Refused with an explicit AE/AR — the engine saw it and said no. */
  refused: number;
  /** No answer at all: timeout, connection error, unreachable. */
  silent: number;
  /** refused + silent — kept for callers that only need "not delivered". */
  failed: number;
  retries: number;
}

/**
 * At-least-once MLLP delivery: wait for each message's ACK (AA) and RETRY any
 * that time out / aren't accepted, in backoff passes. So if the engine dies
 * mid-receive (never ACKs), those messages are re-sent — and land once it's
 * back up. End-to-end durability that fire-and-forget `sendOverMllp` can't give.
 */
export async function sendOverMllpReliable(messages: string[], opts: ReliableOpts = {}): Promise<ReliableResult> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 2575;
  const concurrency = Math.max(1, opts.concurrency ?? 8);
  const ackTimeoutMs = opts.ackTimeoutMs ?? 3000;
  const maxRetries = opts.maxRetries ?? 5;
  const backoffMs = opts.backoffMs ?? 1000;

  // Track INDICES, not message text. Keying the response map by the message
  // body collapsed duplicates, so a batch containing the same message twice
  // reported the refused/silent split wrong.
  let pending = messages.map((_, i) => i);
  let retries = 0;
  // Last response code per still-failing message: present = refused, absent = silent.
  let lastCodes = new Map<number, string | undefined>();
  for (let attempt = 0; attempt <= maxRetries && pending.length > 0; attempt++) {
    if (attempt > 0) {
      retries += pending.length;
      await new Promise((r) => setTimeout(r, backoffMs));
    }
    const batch = pending;
    const failed: number[] = [];
    let i = 0;
    lastCodes = new Map();
    const worker = async (): Promise<void> => {
      while (i < batch.length) {
        const idx = batch[i++]!;
        const code = await deliverOne(host, port, messages[idx]!, ackTimeoutMs);
        if (code !== "AA") { failed.push(idx); lastCodes.set(idx, code); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, batch.length) }, worker));
    pending = failed;
  }
  let refused = 0;
  for (const idx of pending) if (lastCodes.get(idx) !== undefined) refused += 1;
  return { acked: messages.length - pending.length, refused, silent: pending.length - refused, failed: pending.length, retries };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Write one frame, awaiting backpressure drain; rejects if the socket errors. */
function writeFrame(sock: net.Socket, frame: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    // Both listeners come off on either outcome. Leaving the pending `drain`
    // attached when the socket errored accumulated one listener per frame on a
    // long back-pressured stream.
    const done = (): void => { sock.off("error", onErr); sock.off("drain", done); resolve(); };
    const onErr = (e: Error): void => { sock.off("drain", done); reject(e); };
    sock.once("error", onErr);
    if (sock.write(frame)) process.nextTick(done);
    else sock.once("drain", done);
  });
}

export interface LiveStreamOpts extends MllpOpts {
  /** Pull the next message to send; return null/undefined to end the stream.
   *  Called lazily right before each send, so a caller can stamp live time. */
  next: () => string | null | undefined;
  /** Gap (ms) to wait before the NEXT send. Supply an exponential draw
   * (`Rng.exponential`) and the arrivals form a Poisson process. */
  gapMs: () => number;
  onSent?: (n: number, msg: string) => void;
  /** Each ACK's MSA-1 code (AA / AE / AR) as it arrives, or undefined when the
   *  response carries none. Classification only — the stream never waits on it. */
  onAck?: (code: string | undefined) => void;
  /** External stop. When aborted the loop exits after the current send/wait. */
  signal?: AbortSignal;
  /** Reconnect (with backoff) on a dropped socket instead of throwing — lets a
   *  long-running stream survive an engine restart mid-demo. Default false:
   *  a connect/write failure throws, so finite callers fail fast. */
  reconnect?: boolean;
}

// After a stall longer than this (GC pause, reconnect backoff), resync the
// schedule to "now" instead of firing the whole accumulated backlog as a burst.
const MAX_LAG_MS = 250;

/**
 * Stream messages over a single MLLP connection, pulling each lazily from
 * `next()`, with `gapMs()` the intended gap before the next send. Fed
 * exponential gaps the arrivals follow a Poisson process — a realistic feed
 * cadence (organic ebb/flow on the operator dashboard) instead of a flat burst.
 *
 * Pacing is scheduled by ABSOLUTE deadline, not a raw sleep per message: we
 * sleep only when ahead of schedule. So when sub-tick gaps make the OS timer
 * (≈15.5ms granularity on Windows) overshoot, the loop falls behind and skips
 * the sleep — sending the backlog within a tick — instead of capping at the
 * ~64 msg/s timer floor. High `--rate` therefore actually delivers.
 *
 * With `reconnect`, a dropped/refused socket is retried (the in-flight message
 * is resent once the link is back) until `signal` aborts — so the stream
 * outlives an engine restart. Returns the count actually sent.
 */
export async function streamOverMllp(opts: LiveStreamOpts): Promise<number> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 2575;
  const reconnect = opts.reconnect ?? false;
  const aborted = (): boolean => opts.signal?.aborted ?? false;

  let broken = false;
  const connect = async (): Promise<net.Socket> => {
    const s = await open(host, port, opts.onAck);
    broken = false;
    s.on("error", () => { broken = true; });
    s.on("close", () => { broken = true; });
    return s;
  };
  // Return a live socket, reusing `current` unless it's broken. With reconnect,
  // a refused connect is retried (backoff) until the signal aborts.
  const ensureSock = async (current: net.Socket | null): Promise<net.Socket | null> => {
    if (current && !broken) return current;
    if (current) { try { current.end(); } catch { /* gone */ } }
    for (;;) {
      try { return await connect(); }
      catch (e) { if (!reconnect || aborted()) throw e; await sleep(500); }
    }
  };

  let sock: net.Socket | null = null;
  let sent = 0;
  let pending: string | null = null;
  let nextAt = performance.now(); // absolute deadline for the next send
  try {
    while (!aborted()) {
      if (pending == null) {
        const m = opts.next();
        if (m == null) break;
        pending = m;
      }
      const s = (sock = await ensureSock(sock));
      if (!s) break; // aborted while reconnecting
      try {
        await writeFrame(s, mllpFrame(pending));
      } catch (e) {
        broken = true;
        if (!reconnect) throw e;
        continue; // reconnect on next pass and resend the same `pending`
      }
      sent++;
      opts.onSent?.(sent, pending);
      pending = null;

      // Advance the deadline by the intended gap, then sleep only the time that
      // remains. When behind (sub-tick gaps, GC, reconnect) the wait is ≤0 and
      // we send the next message immediately — draining the backlog rather than
      // paying a full timer tick per message.
      nextAt += Math.max(0, opts.gapMs());
      const now = performance.now();
      if (nextAt < now - MAX_LAG_MS) nextAt = now; // long stall — resync, don't burst
      const wait = nextAt - now;
      if (wait > 0 && !aborted()) await sleep(wait);
    }
  } finally {
    // Responses lag the writes, so closing the moment the last message goes out
    // discards the ACKs still on the wire. Without this the tail of every run —
    // and every target switch, which restarts the leg — silently inflates
    // `unanswered`. Linger briefly when someone is listening for them.
    if (sock && opts.onAck) await sleep(ACK_LINGER_MS);
    if (sock) { try { sock.end(); } catch { /* gone */ } }
  }
  return sent;
}
