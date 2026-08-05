import { expect, test } from "bun:test";
import * as net from "node:net";
import { ackCode, mllpFrame, streamOverMllp } from "../src/send/mllp.ts";

const SB = 0x0b;
const EB = 0x1c;

/** Spin a loopback MLLP server that unframes payloads into `onFrame`. */
function listen(
  onFrame: (payload: string, sock: net.Socket) => void,
): Promise<{ port: number; close: () => void }> {
  const srv = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on("data", (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      let eb: number;
      while ((eb = buf.indexOf(EB)) >= 0) {
        const sb = buf.indexOf(SB);
        onFrame(buf.subarray(sb + 1, eb).toString("utf8"), sock);
        buf = buf.subarray(eb + 2); // drop EB + CR
      }
    });
    sock.on("error", () => {}); // client drops are expected in the reconnect test
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      resolve({ port: (srv.address() as net.AddressInfo).port, close: () => srv.close() });
    });
  });
}

const waitFor = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

test("mllp frame wraps payload in SB ... EB CR", () => {
  const f = mllpFrame("MSH|x");
  expect(f[0]).toBe(0x0b); // SB
  expect(f[f.length - 2]).toBe(0x1c); // EB
  expect(f[f.length - 1]).toBe(0x0d); // CR
  expect(f.subarray(1, f.length - 2).toString("utf8")).toBe("MSH|x");
});

test("ackCode reads MSA-1 (AA/AE), undefined when no MSA", () => {
  expect(ackCode("MSH|^~\\&|A|B\rMSA|AA|CTRL1")).toBe("AA");
  expect(ackCode("MSH|^~\\&|A|B\rMSA|AE|CTRL1|err")).toBe("AE");
  expect(ackCode("MSH|^~\\&|A|B")).toBeUndefined();
});

test("streamOverMllp pulls until next() returns null; framing intact, in order", async () => {
  const got: string[] = [];
  const srv = await listen((p) => got.push(p));
  const msgs = ["MSH|a", "MSH|b", "MSH|c"];
  let i = 0;
  const sent = await streamOverMllp({
    port: srv.port,
    next: () => (i < msgs.length ? msgs[i++]! : null),
    gapMs: () => 0,
  });
  await waitFor(() => got.length === msgs.length);
  srv.close();
  expect(sent).toBe(3);
  expect(got).toEqual(msgs);
});

test("streamOverMllp stops promptly when the signal aborts", async () => {
  const got: string[] = [];
  const srv = await listen((p) => got.push(p));
  const ac = new AbortController();
  const sent = await streamOverMllp({
    port: srv.port,
    next: () => "MSH|x", // infinite source — only the signal ends it
    gapMs: () => 5,
    signal: ac.signal,
    onSent: (n) => { if (n >= 3) ac.abort(); },
  });
  srv.close();
  expect(sent).toBe(3);
});

test("streamOverMllp reconnects after a dropped connection and delivers all", async () => {
  const got: string[] = [];
  let dropped = false;
  const srv = await listen((p, sock) => {
    got.push(p);
    if (!dropped) { dropped = true; sock.destroy(); } // drop once, after the first frame
  });
  const msgs = ["MSH|1", "MSH|2", "MSH|3", "MSH|4"];
  let i = 0;
  const sent = await streamOverMllp({
    port: srv.port,
    reconnect: true,
    next: () => (i < msgs.length ? msgs[i++]! : null),
    gapMs: () => 10,
  });
  await waitFor(() => new Set(got).size === msgs.length);
  srv.close();
  expect(new Set(got)).toEqual(new Set(msgs));
  expect(sent).toBe(4);
});

// ── ACK classification (streamOverMllp onAck) ────────────────────────────────
//
// The generator used to discard responses, so it could not tell "delivered"
// from "refused". These pin the framing that makes the difference readable.

const CR = 0x0d;
const ack = (code: string): Buffer =>
  Buffer.concat([
    Buffer.from([SB]),
    Buffer.from(`MSH|^~\\&|SINK|T|||20260730||ACK|1|P|2.5\rMSA|${code}|1\r`, "utf8"),
    Buffer.from([EB, CR]),
  ]);

/** Drive one message through the stream and collect whatever onAck reports. */
async function codesFor(reply: (sock: net.Socket) => void, sends = 1): Promise<(string | undefined)[]> {
  const codes: (string | undefined)[] = [];
  const srv = await listen((_p, sock) => reply(sock));
  const ac = new AbortController();
  let left = sends;
  await streamOverMllp({
    port: srv.port,
    signal: ac.signal,
    next: () => (left-- > 0 ? "MSH|^~\\&|GEN|T|||20260730||ADT^A01|1|P|2.5\r" : null),
    gapMs: () => 1,
    onAck: (c) => codes.push(c),
  });
  await waitFor(() => codes.length > 0, 2000).catch(() => {});
  srv.close();
  return codes;
}

test("an ACK split across two TCP chunks is classified exactly once", async () => {
  const codes = await codesFor((sock) => {
    const full = ack("AA");
    sock.write(full.subarray(0, 12));
    setTimeout(() => sock.write(full.subarray(12)), 30);
  });
  expect(codes).toEqual(["AA"]);
});

test("three ACKs coalesced into one chunk are classified in order", async () => {
  const codes = await codesFor((sock) => {
    sock.write(Buffer.concat([ack("AA"), ack("AR"), ack("AA")]));
  });
  await waitFor(() => codes.length >= 3, 2000).catch(() => {});
  expect(codes).toEqual(["AA", "AR", "AA"]);
});

test("a response carrying no MSA-1 classifies as undefined, not as acceptance", async () => {
  const codes = await codesFor((sock) => {
    sock.write(Buffer.concat([
      Buffer.from([SB]),
      Buffer.from("MSH|^~\\&|SINK|T|||20260730||ACK|1|P|2.5\r", "utf8"),
      Buffer.from([EB, CR]),
    ]));
  });
  expect(codes).toEqual([undefined]);
});

test("without onAck the socket still drains — old callers are unaffected", async () => {
  const srv = await listen((_p, sock) => sock.write(ack("AA")));
  const ac = new AbortController();
  let left = 2;
  const sent = await streamOverMllp({
    port: srv.port,
    signal: ac.signal,
    next: () => (left-- > 0 ? "MSH|^~\\&|GEN|T|||20260730||ADT^A01|1|P|2.5\r" : null),
    gapMs: () => 1,
  });
  srv.close();
  expect(sent).toBe(2);
});

test("ackCode reads AA, AE and AR, and returns undefined when MSA is absent", () => {
  expect(ackCode("MSH|x\rMSA|AA|1\r")).toBe("AA");
  expect(ackCode("MSH|x\rMSA|AE|1\r")).toBe("AE");
  expect(ackCode("MSH|x\rMSA|AR|1\r")).toBe("AR");
  expect(ackCode("MSH|x\r")).toBeUndefined();
});
