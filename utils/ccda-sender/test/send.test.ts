import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendDocument } from "../src/send.ts";

let dir = "";
let doc = "";
let received: { body: string; contentType: string | null; disposition: string | null; sender: string | null; path: string } | null = null;
let server: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ccda-send-"));
  doc = join(dir, "doc.xml");
  writeFileSync(doc, "<ClinicalDocument><title>T</title></ClinicalDocument>");

  // Stands in for the engine's ccda-http source, including its habit of
  // answering 202 for a document it has merely queued.
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/slow") { await Bun.sleep(400); return new Response("late"); }
      if (url.pathname === "/refuse") return new Response("nope", { status: 500 });
      received = {
        body: await req.text(),
        contentType: req.headers.get("content-type"),
        disposition: req.headers.get("content-disposition"),
        sender: req.headers.get("x-sender"),
        path: url.pathname,
      };
      // The engine's own ingest route answers with a tally; a workspace's HTTP
      // source answers 202 for a document it has merely queued.
      if (url.pathname.endsWith("/ingest")) {
        return Response.json({ ingested: 1, received: 1, errored: 0, skipped: 0 });
      }
      return Response.json({ accepted: true }, { status: 202 });
    },
  });
  base = `http://localhost:${server.port}`;
});
afterAll(() => { server.stop(true); rmSync(dir, { recursive: true, force: true }); });

describe("sendDocument", () => {
  test("posts the document as XML and reports the receiver's answer", async () => {
    const r = await sendDocument(doc, `${base}/ccda`);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(202);
    expect(r.body).toBe(`{"accepted":true}`);
    expect(r.transportError).toBeNull();
    expect(r.ms).toBeGreaterThan(0);
    expect(received!.body).toBe("<ClinicalDocument><title>T</title></ClinicalDocument>");
    expect(received!.contentType).toContain("xml");
  });

  test("reports a rejection without turning it into a thrown error", async () => {
    const r = await sendDocument(doc, `${base}/refuse`);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(500);
    expect(r.body).toBe("nope");
  });

  test("names an unreachable receiver", async () => {
    const r = await sendDocument(doc, "http://127.0.0.1:1/ccda");
    expect(r.status).toBeNull();
    expect(r.transportError).not.toBeNull();
  });

  test("gives up on a receiver that never answers, and says how long it waited", async () => {
    // Sub-second waits are reported in milliseconds: rounding them to seconds
    // says "within 0s", which reads as no wait at all.
    const r = await sendDocument(doc, `${base}/slow`, { timeoutMs: 50 });
    expect(r.status).toBeNull();
    expect(r.transportError).toBe("No response within 50ms");
  });

  test("reports a missing file rather than posting nothing", async () => {
    const r = await sendDocument(join(dir, "gone.xml"), `${base}/ccda`);
    expect(r.ok).toBe(false);
    expect(r.transportError).not.toBeNull();
  });
});

describe("the shape a receiver is spoken to in", () => {
  // One endpoint field, two protocols. Which one is used is a property of the
  // address, so a person names a receiver rather than also naming a mode.
  test("a raw receiver takes the document as the body, with its envelope", async () => {
    await sendDocument(doc, `${base}/ccda`, { name: "one.xml" });
    expect(received!.contentType).toBe("application/xml");
    expect(received!.body).toContain("<ClinicalDocument>");
    expect(received!.disposition).toBe('attachment; filename="one.xml"');
    expect(received!.sender).toBe("ccda-sender");
  });

  test("the engine's ingest route takes it as JSON, tagged by format", async () => {
    await sendDocument(doc, `${base}/api/sources/ccda-http/ingest`, { name: "one.xml" });
    expect(received!.contentType).toBe("application/json");
    const body = JSON.parse(received!.body) as { messages: string[]; format: string };
    expect(body.format).toBe("ccda");
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toContain("<ClinicalDocument>");
  });

  test("a trailing slash on the ingest route is still the ingest route", async () => {
    await sendDocument(doc, `${base}/api/sources/s/ingest/`, {});
    expect(received!.contentType).toBe("application/json");
  });

  test("an address that merely mentions sources is not the ingest route", async () => {
    await sendDocument(doc, `${base}/api/sources/ingest/ccda`, {});
    expect(received!.contentType).toBe("application/xml");
  });

  test("a quote in a filename cannot break out of the header", async () => {
    await sendDocument(doc, `${base}/ccda`, { name: 'a"; rm -rf /; x.xml' });
    expect(received!.disposition).toBe('attachment; filename="a; rm -rf /; x.xml"');
  });
});
