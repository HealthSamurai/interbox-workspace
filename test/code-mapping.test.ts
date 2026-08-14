import { test, expect } from "bun:test";
import type { ConceptMapMatch, MapperContext } from "@health-samurai/interbox";
import type { CE } from "@health-samurai/interbox/hl7v2";
import { resolveObservationCode } from "../src/mappers/v2-to-fhir/code-mapping/observation-code-resolver.ts";
import { generateConceptMapId } from "../src/mappers/v2-to-fhir/code-mapping/mapping-types.ts";

const sender = { sendingApplication: "LABCORP", sendingFacility: "HOSPA" };
const CM_ID = generateConceptMapId(sender);

// Minimal stub of the engine-provided terminology lookup (ctx.translate). Entries are real
// ConceptMapMatch values: `equivalence` is always carried and `targetCode` is OPTIONAL, which
// is the distinction the resolver has to act on — absent means the map says this code has no
// LOINC target, and that is not the same as the map not knowing the code at all.
function fakeTranslate(entries: Record<string, ConceptMapMatch>): MapperContext["translate"] {
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
    [`${CM_ID}|K_SERUM`]: {
      targetCode: "2823-3",
      targetDisplay: "Potassium [Moles/volume]",
      equivalence: "equivalent",
    },
  });
  const ce = { $1_code: "K_SERUM", $2_text: "Potassium, serum", $3_system: "urn:labcorp" } as CE;
  const cc = await resolveObservationCode(ce, { sender, translate });
  expect(cc.coding?.[0]).toMatchObject({ system: "http://loinc.org", code: "2823-3" });
  expect(cc.coding?.[1]).toMatchObject({ code: "K_SERUM", system: "urn:labcorp" });
});

// A match with no `targetCode` is the third outcome engine 1.13.0 introduced: the map has
// been asked about this code and records that nothing in LOINC answers it. Publishing the
// local coding alone is the correct FHIR result, and — the reason this matters — throwing
// would return a code a human already reviewed to the unmapped queue on every message.
for (const equivalence of ["unmatched", "disjoint"]) {
  test(`a match with equivalence ${equivalence} publishes the local coding and does not queue`, async () => {
    const translate = fakeTranslate({
      [`${CM_ID}|SITE_ONLY`]: { equivalence, sourceDisplay: "Collection site" },
    });
    const ce = { $1_code: "SITE_ONLY", $2_text: "Collection site", $3_system: "urn:labcorp" } as CE;

    const cc = await resolveObservationCode(ce, { sender, translate });

    expect(cc.coding).toHaveLength(1);
    expect(cc.coding?.[0]).toMatchObject({ code: "SITE_ONLY", system: "urn:labcorp", display: "Collection site" });
    expect(cc.coding?.[0]?.system).not.toBe("http://loinc.org");
    expect(cc.text).toBe("Collection site");
  });
}

// Guards the boundary the type change made reachable: an empty-string target is not a target.
test("a match whose targetCode is absent never emits a LOINC coding without a code", async () => {
  const translate = fakeTranslate({ [`${CM_ID}|NO_TARGET`]: { equivalence: "unmatched" } });
  const ce = { $1_code: "NO_TARGET", $3_system: "urn:labcorp" } as CE;
  const cc = await resolveObservationCode(ce, { sender, translate });
  expect(cc.coding?.every((c) => c.code !== undefined)).toBe(true);
  expect(cc.coding?.some((c) => c.system === "http://loinc.org")).toBe(false);
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
