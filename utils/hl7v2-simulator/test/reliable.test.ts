// sendOverMllpReliable is the delivery path behind every UI send button and
// `send batch --reliable`, and it owns the refused-vs-silent split the whole
// counter model rests on ("two axes, deliberately not mixed" — see ui/actor.ts).
// It had no coverage at all: mllp.test.ts exercises framing and the live stream,
// not this.
import { afterEach, expect, test } from "bun:test";
import * as net from "node:net";
import { mllpFrame, sendOverMllpReliable } from "../src/send/mllp.ts";

const SB = 0x0b;
const EB = 0x1c;

const servers: net.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** Loopback MLLP server; `reply` returns the MSA-1 code, or null to stay silent. */
function listen(reply: (payload: string) => string | null): Promise<number> {
  const srv = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on("data", (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      let eb: number;
      while ((eb = buf.indexOf(EB)) >= 0) {
        const sb = buf.indexOf(SB);
        const payload = buf.subarray(sb + 1, eb).toString("utf8");
        buf = buf.subarray(eb + 2);
        const code = reply(payload);
        if (code === null) continue; // accept the TCP connection, never answer
        const ctrl = payload.split("\r")[0]!.split("|")[9] ?? "1";
        sock.write(mllpFrame(`MSH|^~\\&|T|T|S|S|20260101||ACK|${ctrl}|P|2.5.1\rMSA|${code}|${ctrl}`));
      }
    });
    sock.on("error", () => {});
  });
  servers.push(srv);
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve((srv.address() as net.AddressInfo).port));
  });
}

const MSGS = ["MSH|^~\\&|A|B|C|D|1||ADT^A01|ID-1|P|2.5.1", "MSH|^~\\&|A|B|C|D|2||ADT^A01|ID-2|P|2.5.1", "MSH|^~\\&|A|B|C|D|3||ADT^A01|ID-3|P|2.5.1"];
const FAST = { ackTimeoutMs: 200, maxRetries: 1, backoffMs: 10 };

test("all accepted: acked counts them, nothing refused or silent", async () => {
  const port = await listen(() => "AA");
  const r = await sendOverMllpReliable(MSGS, { port, ...FAST });
  expect(r).toMatchObject({ acked: 3, refused: 0, silent: 0, failed: 0, retries: 0 });
});

test("explicit AE is refused, not silent", async () => {
  const port = await listen(() => "AE");
  const r = await sendOverMllpReliable(MSGS, { port, ...FAST });
  expect(r.acked).toBe(0);
  expect(r.refused).toBe(3);
  expect(r.silent).toBe(0);
  expect(r.retries).toBe(3); // one retry pass over all three
});

test("a listener that never answers is silent, not refused", async () => {
  const port = await listen(() => null);
  const r = await sendOverMllpReliable(MSGS, { port, ...FAST });
  expect(r.acked).toBe(0);
  expect(r.refused).toBe(0);
  expect(r.silent).toBe(3);
});

test("a closed port is silent, not refused", async () => {
  // Bind then immediately release, so the port is almost certainly free.
  const port = await listen(() => "AA");
  for (const s of servers.splice(0)) s.close();
  await new Promise((r) => setTimeout(r, 50));
  const r = await sendOverMllpReliable(MSGS, { port, ...FAST });
  expect(r.acked).toBe(0);
  expect(r.refused).toBe(0);
  expect(r.silent).toBe(3);
});

test("a message accepted on retry is counted as acked", async () => {
  const seen = new Set<string>();
  const port = await listen((payload) => {
    const id = payload.split("|")[9]!;
    if (!seen.has(id)) { seen.add(id); return null; } // ignore the first attempt
    return "AA";
  });
  const r = await sendOverMllpReliable(MSGS, { port, ...FAST, maxRetries: 2 });
  expect(r.acked).toBe(3);
  expect(r.failed).toBe(0);
  expect(r.retries).toBeGreaterThan(0);
});

// Prove-It: the response map used to be keyed by message TEXT, so two identical
// bodies shared one entry and the LAST outcome overwrote the first. Answer the
// first copy with an explicit refusal and stay silent on the second: the old
// code recorded `undefined` for both and reported refused=0 / silent=2, losing
// the refusal it was actually told about.
test("identical bodies with different outcomes are accounted separately", async () => {
  let seen = 0;
  const port = await listen(() => (++seen === 1 ? "AR" : null));
  const r = await sendOverMllpReliable([MSGS[0]!, MSGS[0]!], {
    port, concurrency: 1, ackTimeoutMs: 200, maxRetries: 0, backoffMs: 10,
  });
  expect(r.acked).toBe(0);
  expect(r.failed).toBe(2);
  expect(r.refused).toBe(1);
  expect(r.silent).toBe(1);
});
