import { test, expect } from "bun:test";
import { MapperRegistry, type MapperContext, type MapperSource } from "@health-samurai/interbox";
import { parseHl7v2, type HL7v2Segment } from "@health-samurai/interbox/hl7v2";
import "../src/mappers/index.ts"; // registers v2-to-fhir

// The mapper emits a FHIR Provenance alongside its output, so the destination
// holds a record of which inbound message produced what. Interbox itself keeps
// that on the queue row and sends nothing of its own, so this resource is the
// only thing that carries it to the FHIR server — worth pinning.

// PV1-19 (Visit Number) is required for A01 — it becomes the Encounter's id — so
// the trailing pipes carry the segment out to field 19.
const ADT_A01 = [
  "MSH|^~\\&|LABCORP|HOSPA|RECV|RECVFAC|20260729100000||ADT^A01|MSG00001|P|2.5.1",
  "EVN|A01|20260729100000",
  "PID|1||PATID1234^^^HOSPA^MR||DOE^JOHN^A||19700101|M",
  `PV1|1|I|WARD1^101^1^HOSPA${"|".repeat(16)}VISIT123`,
].join("\r");

const source: MapperSource = {
  format: "hl7v2",
  id: "42",
  pipeline: "hl7-to-aidbox",
  receivedAt: "2026-07-29T10:00:00.000Z",
};

const ctx: MapperContext = {
  source,
  translate: async () => undefined,
  webhook: () => {},
};

async function mapMessage(raw: string): Promise<Record<string, unknown>[]> {
  const def = MapperRegistry.get("v2-to-fhir");
  if (!def) throw new Error("v2-to-fhir is not registered");
  const segments = parseHl7v2(raw) as unknown as HL7v2Segment[];
  const out = await def.map({}, segments, ctx);
  return out as Record<string, unknown>[];
}

const provenanceOf = (rs: Record<string, unknown>[]) =>
  rs.find((r) => r.resourceType === "Provenance") as
    | { id: string; recorded: string; agent: { who: { display?: string; reference?: string } }[]; target: { reference: string }[] }
    | undefined;

test("the mapper emits exactly one Provenance for the message", async () => {
  const out = await mapMessage(ADT_A01);
  expect(out.filter((r) => r.resourceType === "Provenance")).toHaveLength(1);
});

test("it targets every other resource the message produced", async () => {
  const out = await mapMessage(ADT_A01);
  const p = provenanceOf(out)!;
  const others = out
    .filter((r) => r.resourceType !== "Provenance")
    .map((r) => `${r.resourceType as string}/${r.id as string}`);

  expect(others.length).toBeGreaterThan(0);
  expect(p.target.map((t) => t.reference).sort()).toEqual(others.sort());
});

test("its id is derived from the message, so a re-map overwrites its own record", async () => {
  const a = provenanceOf(await mapMessage(ADT_A01))!;
  const b = provenanceOf(await mapMessage(ADT_A01))!;
  expect(a.id).toBe("ib-hl7v2-42");
  expect(b.id).toBe(a.id);
});

// A Retry re-maps the same inbound row. Deriving `recorded` from the ingest time
// rather than the clock keeps the output byte-identical, so the sender's content
// hash lets it skip instead of rewriting the destination.
test("recorded comes from the message's ingest time, not the clock", async () => {
  const p = provenanceOf(await mapMessage(ADT_A01))!;
  expect(p.recorded).toBe(source.receivedAt);
});

// The sender blocks a bundle until every reference in it resolves. An agent
// pointing at a resource that does not exist would block it forever, so the
// default agent must carry a display and no reference.
test("the agent carries no unresolvable reference", async () => {
  const p = provenanceOf(await mapMessage(ADT_A01))!;
  expect(p.agent).toHaveLength(1);
  expect(p.agent[0]!.who.display).toBe("Interbox");
  expect(p.agent[0]!.who.reference).toBeUndefined();
});

// Interbox no longer writes anything into the resources it sends.
test("no interbox meta tags are added to any resource", async () => {
  const out = await mapMessage(ADT_A01);
  const systems = out.flatMap(
    (r) => ((r.meta as { tag?: { system: string }[] } | undefined)?.tag ?? []).map((t) => t.system),
  );
  expect(systems.filter((s) => s.startsWith("urn:interbox:"))).toEqual([]);
});

// Every resource must carry resourceType + id or the engine errors the whole
// message — the Provenance included.
test("every emitted resource is enqueueable", async () => {
  for (const r of await mapMessage(ADT_A01)) {
    expect(typeof r.resourceType).toBe("string");
    expect(typeof r.id).toBe("string");
  }
});
