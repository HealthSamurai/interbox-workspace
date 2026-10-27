import { expect, test } from "bun:test";
import { afterStore, type StepContext, type UnitOutcome } from "@health-samurai/interbox/chain";
import type { Provenance } from "@health-samurai/interbox/fhir";
import { parseHl7v2 } from "@health-samurai/interbox/hl7v2";
import { v2ToFhir } from "../src/mappers/v2-to-fhir/index.ts";

const ADT_A01 = [
  "MSH|^~\\&|LABCORP|HOSPA|RECV|RECVFAC|20260729100000||ADT^A01|MSG00001|P|2.5.1",
  "EVN|A01|20260729100000",
  "PID|1||PATID1234^^^HOSPA^MR||DOE^JOHN^A||19700101|M",
  `PV1|1|I|WARD1^101^1^HOSPA${"|".repeat(16)}VISIT123`,
].join("\r");

const UNIT_ID = 42n;
const UNIT_CREATED_AT = new Date("2026-07-29T10:00:00.000Z");

interface Emitted {
  readonly resourceType: string;
  readonly id?: unknown;
  readonly meta?: { readonly tag?: readonly { readonly system: string }[] };
}

const unused = (what: string) => (): never => {
  throw new Error(`the mapping step uses no ${what} for an ADT^A01`);
};

const context: StepContext = {
  signal: new AbortController().signal,
  state: unused("state"),
  sender: { queued: unused("sender queue") },
  units: { count: unused("units"), find: unused("units") },
  translate: unused("terminology"),
  translateFor: unused("terminology"),
  conceptMapFor: unused("terminology"),
  lookup: unused("lookup"),
};

function itemsOf(outcome: UnitOutcome | undefined): Emitted[] {
  if (outcome?.kind === "items") return outcome.items.map((item) => item.value as Emitted);
  const cause = outcome?.kind === "error" ? `: ${String(outcome.error)}` : "";
  throw new Error(`the unit ended ${outcome?.kind ?? "with no outcome"}, not with items${cause}`);
}

async function mapped(raw: string): Promise<Emitted[]> {
  const run = afterStore([{ id: UNIT_ID, value: parseHl7v2(raw), createdAt: UNIT_CREATED_AT }], {
    pipeline: "hl7-to-aidbox",
    context,
  });
  const outcomes = await run.settle(await v2ToFhir.fn(run.batch, context));
  return itemsOf(outcomes.get(UNIT_ID));
}

const isProvenance = (resource: Emitted): boolean => resource.resourceType === "Provenance";

async function provenanceOf(raw: string): Promise<Provenance> {
  const provenance = (await mapped(raw)).find(isProvenance);
  if (provenance === undefined) throw new Error("the mapping step emitted no Provenance");
  return provenance as unknown as Provenance;
}

test("the mapping step emits exactly one Provenance for the message", async () => {
  expect((await mapped(ADT_A01)).filter(isProvenance)).toHaveLength(1);
});

test("the Provenance targets every other resource the message produced", async () => {
  const resources = await mapped(ADT_A01);
  const others = resources.filter((r) => !isProvenance(r)).map((r) => `${r.resourceType}/${String(r.id)}`);
  const targets: (string | undefined)[] = (await provenanceOf(ADT_A01)).target.map((t) => t.reference);

  expect(others.length).toBeGreaterThan(0);
  expect(targets.sort()).toEqual(others.sort());
});

test("the Provenance id is provenanceId of the unit, ib-<unit id>-<creation time in base-36 ms>, the same on a Retry", async () => {
  const first = await provenanceOf(ADT_A01);
  const retried = await provenanceOf(ADT_A01);
  expect(first.id).toBe("ib-42-ms5wyf40");
  expect(retried.id).toBe(first.id);
});

test("recorded is the unit's creation time, not the clock", async () => {
  expect((await provenanceOf(ADT_A01)).recorded).toBe(UNIT_CREATED_AT.toISOString());
});

test("the agent is a display with no reference the sender would have to resolve", async () => {
  const { agent } = await provenanceOf(ADT_A01);
  expect(agent).toHaveLength(1);
  expect(agent[0]?.who.display).toBe("Interbox");
  expect(agent[0]?.who.reference).toBeUndefined();
});

test("no resource carries an interbox meta tag", async () => {
  const systems = (await mapped(ADT_A01)).flatMap((r) => (r.meta?.tag ?? []).map((t) => t.system));
  expect(systems.filter((s) => s.startsWith("urn:interbox:"))).toEqual([]);
});

test("every emitted resource has the resourceType and id fhirItems() keys it by", async () => {
  for (const resource of await mapped(ADT_A01)) {
    expect(typeof resource.resourceType).toBe("string");
    expect(typeof resource.id).toBe("string");
  }
});
