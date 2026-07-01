import { test, expect } from "bun:test";
import type { MapperContext } from "@healthsamurai/interbox";
import type { CE } from "@healthsamurai/interbox/hl7v2";
import { resolveObservationCode } from "../src/mappers/v2-to-fhir/code-mapping/observation-code-resolver.ts";
import { generateConceptMapId } from "../src/mappers/v2-to-fhir/code-mapping/mapping-types.ts";

const sender = { sendingApplication: "LABCORP", sendingFacility: "HOSPA" };
const CM_ID = generateConceptMapId(sender);

// Minimal stub of the engine-provided terminology lookup (ctx.translate).
function fakeTranslate(
  entries: Record<string, { targetCode: string; targetDisplay?: string }>,
): MapperContext["translate"] {
  return async (cmId: string, code: string) => entries[`${cmId}|${code}`];
}

test("conceptMapId is sender-scoped and slugged", () => {
  expect(CM_ID).toBe("hl7v2-labcorp-hospa-observation-code-loinc");
});

test("inline LOINC (comp-3 = LN) passes through without a map", async () => {
  const ce = { $1_code: "2823-3", $2_text: "Potassium", $3_system: "LN" } as CE;
  const cc = await resolveObservationCode(ce, { sender, translate: fakeTranslate({}) });
  expect(cc.coding?.[0]).toMatchObject({ system: "http://loinc.org", code: "2823-3" });
});

test("local code resolves via translate, keeping the local coding", async () => {
  const translate = fakeTranslate({
    [`${CM_ID}|K_SERUM`]: { targetCode: "2823-3", targetDisplay: "Potassium [Moles/volume]" },
  });
  const ce = { $1_code: "K_SERUM", $2_text: "Potassium, serum", $3_system: "urn:labcorp" } as CE;
  const cc = await resolveObservationCode(ce, { sender, translate });
  expect(cc.coding?.[0]).toMatchObject({ system: "http://loinc.org", code: "2823-3" });
  expect(cc.coding?.[1]).toMatchObject({ code: "K_SERUM", system: "urn:labcorp" });
});

test("unmapped code throws code/unmapped_observation_code with a parseable message", async () => {
  const ce = { $1_code: "GLU_FAST", $2_text: "Glucose fasting", $3_system: "urn:labcorp" } as CE;
  let thrown: unknown;
  try {
    await resolveObservationCode(ce, { sender, translate: fakeTranslate({}) });
  } catch (e) {
    thrown = e;
  }
  const err = thrown as { kind?: string; message?: string };
  expect(err.kind).toBe("code/unmapped_observation_code");
  expect(err.message).toContain('unmapped code "GLU_FAST"');
  expect(err.message).toContain("(Glucose fasting)");
  expect(err.message).toContain(`map ${CM_ID}`);
});
