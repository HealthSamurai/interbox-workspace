/**
 * Posting a document to the engine.
 *
 * A success answer covers the queuing, not the conversion: a malformed CDA
 * becomes an error row for the operator, not an HTTP error. So this reports
 * what the transport did and stops there. Judging the document is the
 * dashboard's job, and claiming to do it here would produce a green tick over
 * a document that never landed.
 */

import { file } from "bun";

import { decodeDocument } from "./decode.ts";

export interface SendResult {
  ok: boolean;
  status: number | null;
  statusText: string;
  /** Round trip in milliseconds. */
  ms: number;
  /** Response body, capped — the receiver answers with a short JSON object. */
  body: string;
  /** Set when the request never reached a server. */
  transportError: string | null;
}

/** Response bodies beyond this are cut: nothing the receiver returns is large. */
const MAX_BODY = 8 * 1024;

/**
 * The engine's own ingest route, which takes documents as JSON rather than as a
 * raw body: `POST /api/sources/<source>/ingest`.
 *
 * Recognized from the address rather than from a setting. The endpoint field is
 * already the one place a person says where documents go, and the shape of a
 * receiver is a property of its address — a second control asking which protocol
 * to speak would be a second place to get it wrong.
 */
const INGEST_ROUTE = /\/api\/sources\/[^/]+\/ingest\/?$/;

/** What a document is called in the engine's parser registry. */
const FORMAT = "ccda";

export interface SendOptions {
  /** Give up after this many milliseconds. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SendOptionsWithName extends SendOptions {
  /** The document's filename, recorded by the receiver as what it was called. */
  name?: string;
  /** Who the receiver should record as the sender. */
  sender?: string;
}

/**
 * POST one document to `endpoint`, in whichever shape that endpoint speaks.
 *
 * A raw-body receiver takes the document as it sits on disk, streamed rather
 * than read into a string: documents in this corpus reach 12 MB, and buffering
 * each one through a batch run would hold the whole library in memory for no
 * reason. The engine's own ingest route takes JSON instead, so that path has to
 * decode the file and carry it as a string — the cost of speaking the protocol
 * the stock engine offers.
 */
export async function sendDocument(path: string, endpoint: string, opts: SendOptionsWithName = {}): Promise<SendResult> {
  // Streamed off disk for the raw path; the ingest path needs the bytes anyway.
  const viaIngest = speaksIngest(endpoint);
  return post(viaIngest ? await file(path).arrayBuffer() : file(path), endpoint, opts);
}

/** The same send for a document that never had a path — one dropped onto the page. */
export async function sendBytes(bytes: ArrayBuffer, endpoint: string, opts: SendOptionsWithName = {}): Promise<SendResult> {
  return post(bytes, endpoint, opts);
}

const speaksIngest = (endpoint: string): boolean => {
  try {
    return INGEST_ROUTE.test(new URL(endpoint, "http://localhost").pathname);
  } catch {
    return false;
  }
};

async function post(payload: ArrayBuffer | ReturnType<typeof file>, endpoint: string, opts: SendOptionsWithName): Promise<SendResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const started = performance.now();

  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const viaIngest = speaksIngest(endpoint);

  try {
    const init: RequestInit = viaIngest
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Decoded by the encoding the document declares: JSON carries text, and
          // a windows-1252 export read as UTF-8 would reach the engine with its
          // accented names already replaced.
          body: JSON.stringify({
            messages: [decodeDocument(payload instanceof ArrayBuffer ? payload : await payload.arrayBuffer())],
            format: FORMAT,
          }),
          signal,
        }
      : {
          method: "POST",
          headers: {
            "Content-Type": "application/xml",
            // What the document was called and who sent it. The engine records
            // both beside the row, and they are the only way back to the original
            // for a document that never parsed.
            ...(opts.name ? { "Content-Disposition": `attachment; filename="${opts.name.replace(/"/g, "")}"` } : {}),
            "X-Sender": opts.sender ?? "ccda-sender",
          },
          body: payload,
          signal,
        };
    const res = await fetch(endpoint, init);
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      ms: performance.now() - started,
      body: text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}…` : text,
      transportError: null,
    };
  } catch (err) {
    const e = err as Error;
    // A refused connection and an expired deadline are the two everyday
    // failures here, and they call for different fixes — name them apart.
    const reason = e.name === "TimeoutError" || e.name === "AbortError"
      ? `No response within ${timeoutMs < 1000 ? `${timeoutMs}ms` : `${Math.round(timeoutMs / 1000)}s`}`
      : e.message;
    return {
      ok: false, status: null, statusText: "", ms: performance.now() - started,
      body: "", transportError: reason,
    };
  }
}
