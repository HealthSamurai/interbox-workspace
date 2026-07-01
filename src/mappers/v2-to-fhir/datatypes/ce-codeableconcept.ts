import type { CE } from "@healthsamurai/interbox/hl7v2";
import type { CodeableConcept, Coding } from "@healthsamurai/interbox/fhir/4.0.1";

export function convertCEToCodeableConcept(
  ce: CE | undefined,
): CodeableConcept | undefined {
  if (!ce) {return undefined;}

  const codings: Coding[] = [];

  if (ce.$1_code || ce.$2_text) {
    codings.push({
      ...(ce.$1_code && { code: ce.$1_code }),
      ...(ce.$2_text && { display: ce.$2_text }),
      ...(ce.$3_system && { system: ce.$3_system }),
    });
  }

  if (ce.$4_altCode || ce.$5_altDisplay) {
    codings.push({
      ...(ce.$4_altCode && { code: ce.$4_altCode }),
      ...(ce.$5_altDisplay && { display: ce.$5_altDisplay }),
      ...(ce.$6_altSystem && { system: ce.$6_altSystem }),
    });
  }

  if (codings.length === 0) {return undefined;}

  return {
    coding: codings,
    ...(ce.$2_text && { text: ce.$2_text }),
  };
}
