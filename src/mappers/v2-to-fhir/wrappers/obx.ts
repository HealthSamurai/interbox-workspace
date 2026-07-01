/**
 * Wrapper for fromOBX that fixes value parsing for SN and CE/CWE types.
 *
 * The generated parser has two bugs with OBX-5 (Observation Value):
 *
 * 1. SN (Structured Numeric): treats `^` as a component separator, but in SN values
 *    the caret is part of the data format (e.g., ">^90" means "greater than 90").
 *
 * 2. CE/CWE (Coded Entry): when the raw field is a parsed object (component structure),
 *    the generated parser only handles string and array cases, silently dropping the value.
 *    This wrapper reconstructs the string for $5_observationValue and also provides
 *    the structured CE in $5_observationValueCE.
 */

import type { HL7v2Segment, FieldValue } from "@health-samurai/interbox/hl7v2";
import { getComponent } from "@health-samurai/interbox/hl7v2";
import type { OBX, CE } from "@health-samurai/interbox/hl7v2";
import { fromOBX as fromOBXGenerated } from "@health-samurai/interbox/hl7v2";

/**
 * Extended OBX with a structured CE field for coded observation values.
 *
 * The generated OBX type only has `$5_observationValue: string[]`, which loses
 * CE/CWE structure. This adds `$5_observationValueCE` populated when OBX-2 is CE or CWE.
 */
export interface WrappedOBX extends OBX {
  $5_observationValueCE?: CE;
}

/**
 * Reconstruct SN (Structured Numeric) value from parsed components.
 * SN uses caret (^) as internal separator, which gets incorrectly split by the parser.
 *
 * Examples:
 * - {1: ">", 2: "90"} → ">^90" (greater than 90)
 * - {1: "", 2: "10", 3: "-", 4: "20"} → "^10^-^20" (range 10-20)
 * - {1: "", 2: "1", 3: ":", 4: "128"} → "^1^:^128" (ratio 1:128)
 */
function reconstructSNValue(rawField: unknown): string | undefined {
  if (!rawField) {return undefined;}
  if (typeof rawField === "string") {return rawField;}

  if (typeof rawField === "object" && rawField !== null) {
    const obj = rawField as Record<string, string>;
    const parts: string[] = [];
    let i = 1;
    let val = obj[i];
    while (val !== undefined) {
      parts.push(val);
      i++;
      val = obj[i];
    }
    return parts.join("^");
  }

  return undefined;
}

/**
 * Parse CE/CWE value from raw OBX-5 field components.
 *
 * When OBX-2 is CE or CWE, the raw field 5 is a component structure
 * {1: code, 2: text, 3: system, ...} that the generated parser drops.
 * This extracts it as a typed CE and also reconstructs the string representation
 * (e.g., "V02^VFC ELIGIBLE^HL70064") for backward-compatible consumers.
 */
function parseCEValue(rawField: FieldValue | undefined): { ce: CE; stringValue: string } | undefined {
  if (!rawField || typeof rawField !== "object" || Array.isArray(rawField)) {
    return undefined;
  }

  const ce: CE = {
    $1_code: getComponent(rawField, 1) || undefined,
    $2_text: getComponent(rawField, 2) || undefined,
    $3_system: getComponent(rawField, 3) || undefined,
    $4_altCode: getComponent(rawField, 4) || undefined,
    $5_altDisplay: getComponent(rawField, 5) || undefined,
    $6_altSystem: getComponent(rawField, 6) || undefined,
  };

  // Reconstruct string: "code^text^system^altCode^altText^altSystem", trimming trailing empties
  const parts = [ce.$1_code, ce.$2_text, ce.$3_system, ce.$4_altCode, ce.$5_altDisplay, ce.$6_altSystem];
  let lastNonEmpty = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i]) {
      lastNonEmpty = i;
      break;
    }
  }
  const stringValue = parts.slice(0, lastNonEmpty + 1).map((p) => p ?? "").join("^");

  return { ce, stringValue };
}

/**
 * Parse OBX segment with proper SN and CE/CWE value handling.
 *
 * Fixes two bugs in the generated fromOBX:
 * - SN values: reconstructs the caret-separated string from parsed components
 * - CE/CWE values: extracts the structured CE and reconstructs the string representation
 */
export function fromOBX(segment: HL7v2Segment): WrappedOBX {
  const obx: WrappedOBX = fromOBXGenerated(segment);
  const valueType = obx.$2_valueType?.toUpperCase();

  if (valueType === "SN") {
    const rawField = segment.fields[5];
    const reconstructed = reconstructSNValue(rawField);
    if (reconstructed) {
      obx.$5_observationValue = [reconstructed];
    }
  } else if (valueType === "CE" || valueType === "CWE") {
    const rawField = segment.fields[5];
    const parsed = parseCEValue(rawField);
    if (parsed) {
      obx.$5_observationValueCE = parsed.ce;
      obx.$5_observationValue = [parsed.stringValue];
    }
  }

  return obx;
}
