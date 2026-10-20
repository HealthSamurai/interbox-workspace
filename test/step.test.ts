import { expect, test } from "bun:test";
import type { ConceptMapMatch } from "@health-samurai/interbox";
import { afterStore, type StepContext, type UnitOutcome } from "@health-samurai/interbox/chain";
import type { Observation } from "@health-samurai/interbox/fhir";
import { parseHl7v2 } from "@health-samurai/interbox/hl7v2";
import { generateConceptMapId } from "../src/mappers/v2-to-fhir/code-mapping/mapping-types.ts";
import { v2ToFhir } from "../src/mappers/v2-to-fhir/index.ts";
import { convertADT_A01 } from "../src/mappers/v2-to-fhir/messages/adt-a01.ts";

const ADT_A01 = [
  "MSH|^~\\&|LABCORP|HOSPA|RECV|RECVFAC|20260729100000||ADT^A01|MSG00001|P|2.5.1",
  "EVN|A01|20260729100000",
  "PID|1||PATID1234^^^HOSPA^MR||DOE^JOHN^A||19700101|M",
  `PV1|1|I|WARD1^101^1^HOSPA${"|".repeat(16)}VISIT123`,
].join("\r");

const LOCAL_CODE = "K_SERUM";
const LOINC_POTASSIUM = "2823-3";

const ORU_R01_WITH_A_LOCAL_OBX_3 = [
  "MSH|^~\\&|LABCORP|HOSPA|RECV|RECVFAC|20260729100000||ORU^R01|MSG00002|P|2.5.1",
  "PID|1||PATID1234^^^HOSPA^MR||DOE^JOHN^A||19700101|M",
  "OBR|1|ORD1|FIL1|PANEL^Basic panel^L|||20260729100000",
  `OBX|1|NM|${LOCAL_CODE}^Potassium, serum^L||4.1|mmol/L|||||F`,
].join("\r");

const POTASSIUM_MAP = generateConceptMapId({ sendingApplication: "LABCORP", sendingFacility: "HOSPA" });

const UNIT_ID = 42n;
const RECEIVED_AT = new Date("2026-07-29T10:00:00.000Z");

const refusal = (what: string) => (): never => {
  throw new Error(`the mapping step ${what}`);
};

const readsNothing: StepContext = {
  signal: new AbortController().signal,
  state: refusal("reads no state"),
  sender: { queued: refusal("reads no sender queue") },
  units: { count: refusal("reads no units"), find: refusal("reads no units") },
  translate: refusal("translates no code"),
  translateFor: refusal("translates no code"),
  conceptMapFor: refusal("resolves no concept map"),
};

function itemsOf(outcome: UnitOutcome | undefined): unknown[] {
  if (outcome?.kind === "items") return outcome.items.map((item) => item.value);
  const cause = outcome?.kind === "error" ? `: ${String(outcome.error)}` : "";
  throw new Error(`the unit ended ${outcome?.kind ?? "with no outcome"}, not with items${cause}`);
}

async function mapped(raw: string, context: StepContext = readsNothing): Promise<unknown[]> {
  const run = afterStore([{ id: UNIT_ID, value: parseHl7v2(raw), createdAt: RECEIVED_AT }], {
    pipeline: "hl7-to-aidbox",
    context,
  });
  const outcomes = await run.settle(await v2ToFhir.fn(run.batch, context));
  return itemsOf(outcomes.get(UNIT_ID));
}

const isProvenance = (resource: unknown): boolean =>
  (resource as { resourceType?: unknown }).resourceType === "Provenance";

const isObservation = (resource: unknown): resource is Observation =>
  (resource as { resourceType?: unknown }).resourceType === "Observation";

test("the mapping step turns an ADT^A01 into the resources convertADT_A01 makes of it, Provenance aside", async () => {
  const resources = await mapped(ADT_A01);
  expect(resources.filter((resource) => !isProvenance(resource))).toEqual(convertADT_A01(parseHl7v2(ADT_A01)));
});

test("the mapping step hands its ctx.translate to the ORU^R01 converter, which codes the OBX-3 local code as the LOINC it translates to", async () => {
  const asked: [string, string][] = [];
  const translatesPotassium: StepContext = {
    ...readsNothing,
    translate: async (map: string, code: string): Promise<ConceptMapMatch | undefined> => {
      asked.push([map, code]);
      return { targetCode: LOINC_POTASSIUM, targetDisplay: "Potassium [Moles/volume] in Serum or Plasma", equivalence: "equivalent" };
    },
  };

  const observations = (await mapped(ORU_R01_WITH_A_LOCAL_OBX_3, translatesPotassium)).filter(isObservation);

  expect(asked).toEqual([[POTASSIUM_MAP, LOCAL_CODE]]);
  expect(observations).toHaveLength(1);
  expect(observations[0]?.code.coding?.[0]).toMatchObject({ system: "http://loinc.org", code: LOINC_POTASSIUM });
});
