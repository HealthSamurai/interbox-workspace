import type { CodeableConcept, Coding } from "@healthsamurai/interbox/fhir/4.0.1";

/**
 * Converts ID (Coded Value) to boolean.
 *
 * Mapping:
 * - ID value -> boolean (Y/Yes/1/true -> true, N/No/0/false -> false)
 *
 * Note: Vocabulary mapping is typically done at the segment's field level.
 */
export function convertIDToBoolean(id: string | undefined): boolean | undefined {
  if (!id) {return undefined;}

  const normalized = id.toLowerCase().trim();

  if (normalized === "y" || normalized === "yes" || normalized === "1" || normalized === "true") {
    return true;
  }

  if (normalized === "n" || normalized === "no" || normalized === "0" || normalized === "false") {
    return false;
  }

  return undefined;
}

/**
 * Converts ID (Coded Value) to FHIR code.
 *
 * Mapping:
 * - ID value -> $value (code)
 *
 * Note: Vocabulary mapping is typically done at the segment's field level.
 */
export function convertIDToCode(id: string | undefined): string | undefined {
  if (!id) {return undefined;}
  return id;
}

/**
 * Converts ID (Coded Value) to CodeableConcept.
 *
 * Mapping:
 * - ID value -> coding[0].code
 */
export function convertIDToCodeableConcept(id: string | undefined): CodeableConcept | undefined {
  if (!id) {return undefined;}

  return {
    coding: [{ code: id }],
  };
}

/**
 * Converts ID (Coded Value) to CodeableConcept with Universal ID system.
 *
 * Mapping:
 * - ID value -> coding[0].code
 * - coding[0].system = "http://terminology.hl7.org/CodeSystem/v2-0301"
 */
export function convertIDToCodeableConceptUniversalID(id: string | undefined): CodeableConcept | undefined {
  if (!id) {return undefined;}

  return {
    coding: [
      {
        code: id,
        system: "http://terminology.hl7.org/CodeSystem/v2-0301",
      },
    ],
  };
}

/**
 * Converts ID (Coded Value) to Coding.
 *
 * Mapping:
 * - ID value -> code
 */
export function convertIDToCoding(id: string | undefined): Coding | undefined {
  if (!id) {return undefined;}

  return {
    code: id,
  };
}

/**
 * Converts ID (Coded Value) to string.
 *
 * Mapping:
 * - ID value -> $value (string)
 */
export function convertIDToString(id: string | undefined): string | undefined {
  if (!id) {return undefined;}
  return id;
}
