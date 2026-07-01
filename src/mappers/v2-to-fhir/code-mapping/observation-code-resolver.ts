import type { CE } from "@healthsamurai/interbox/hl7v2";
import type { CodeableConcept, Coding } from "@healthsamurai/interbox/fhir/4.0.1";
import { domainError, type MapperContext } from "@healthsamurai/interbox";
import type { Sender } from "../support/msh.ts";
import { generateConceptMapId, LOINC_SYSTEM } from "./mapping-types.ts";

// Threaded from the ORU converter down to the OBX converter. When present, OBX-3
// is resolved to LOINC via the engine's terminology (MapperContext.translate);
// when absent (offline tests, non-ORU messages), the OBX converter keeps its raw
// passthrough behavior.
export interface CodeMappingContext {
  sender: Sender;
  translate: MapperContext["translate"];
}

// HL7v2 "name of coding system" values that already denote LOINC — such a code
// is standard and needs no mapping.
const LOINC_NAMES = new Set(["LN", "LOINC", LOINC_SYSTEM]);

function loincCoding(code: string, display: string | undefined): Coding {
  return { system: LOINC_SYSTEM, code, ...(display && { display }) };
}

/**
 * Resolve an OBX-3 observation identifier to a LOINC-coded CodeableConcept.
 *
 *  1. Inline LOINC — if the primary (comp 1-3) or alternate (comp 4-6) coding
 *     already names LOINC, use it directly.
 *  2. Otherwise translate the local code through the sender's ConceptMap; on a
 *     hit, emit the LOINC coding plus the original local coding for provenance.
 *  3. On a miss, throw code/unmapped_observation_code. The message errors and
 *     the unmapped-code queue (Code mappings screen) is derived from that error;
 *     once a human maps the code, retrying the message resolves it.
 *
 * The error message is human-readable AND parseable (the read API extracts
 * code/display/system/map from it) — keep the `· field ·` layout stable.
 */
export async function resolveObservationCode(ce: CE, ctx: CodeMappingContext): Promise<CodeableConcept> {
  // 1. inline LOINC (primary, then alternate)
  if (ce.$1_code && ce.$3_system && LOINC_NAMES.has(ce.$3_system)) {
    return { coding: [loincCoding(ce.$1_code, ce.$2_text)], ...(ce.$2_text && { text: ce.$2_text }) };
  }
  if (ce.$4_altCode && ce.$6_altSystem && LOINC_NAMES.has(ce.$6_altSystem)) {
    return { coding: [loincCoding(ce.$4_altCode, ce.$5_altDisplay)], ...(ce.$5_altDisplay && { text: ce.$5_altDisplay }) };
  }

  const localCode = ce.$1_code?.trim();
  if (!localCode) {
    throw domainError("field", "missing_observation_code", "OBX-3.1 (observation identifier code) is empty");
  }

  const conceptMapId = generateConceptMapId(ctx.sender);
  const mapped = await ctx.translate(conceptMapId, localCode);
  if (mapped) {
    const local: Coding = {
      code: localCode,
      ...(ce.$2_text && { display: ce.$2_text }),
      ...(ce.$3_system && { system: ce.$3_system }),
    };
    const text = mapped.targetDisplay ?? ce.$2_text;
    return { coding: [loincCoding(mapped.targetCode, mapped.targetDisplay), local], ...(text && { text }) };
  }

  // 3. unmapped — parseable message (see API unmappedCodes extraction)
  const system = ce.$3_system || "(none)";
  throw domainError(
    "code",
    "unmapped_observation_code",
    `unmapped code "${localCode}"${ce.$2_text ? ` (${ce.$2_text})` : ""} · system ${system} · map ${conceptMapId}`,
  );
}
