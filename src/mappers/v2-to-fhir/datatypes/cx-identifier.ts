import type { CX } from "@health-samurai/interbox/hl7v2";
import type { Identifier, CodeableConcept, Period } from "@health-samurai/interbox/fhir/4.0.1";

/**
 * Converts CX (Extended Composite ID with Check Digit) to FHIR Identifier.
 *
 * Mapping:
 * - CX.1 (ID Number) -> value
 * - CX.4 (Assigning Authority) -> system (from HD.2 Universal ID)
 * - CX.5 (Identifier Type Code) -> type.coding.code
 * - CX.7 (Effective Date) -> period.start
 * - CX.8 (Expiration Date) -> period.end
 */
export function convertCXToIdentifier(cx: CX | undefined): Identifier | undefined {
  if (!cx) {return undefined;}
  if (!cx.$1_value) {return undefined;}

  const identifier: Identifier = {
    value: cx.$1_value,
  };

  // Map assigning authority (HD) to system
  if (cx.$4_system) {
    const system = cx.$4_system.$2_system ?? cx.$4_system.$1_namespace;
    if (system) {
      identifier.system = system;
    }
  }

  // Map identifier type code
  if (cx.$5_type) {
    const type: CodeableConcept = {
      coding: [{ code: cx.$5_type }],
    };
    identifier.type = type;
  }

  // Map period (effective and expiration dates)
  if (cx.$7_start || cx.$8_end) {
    const period: Period = {};
    if (cx.$7_start) {period.start = cx.$7_start;}
    if (cx.$8_end) {period.end = cx.$8_end;}
    identifier.period = period;
  }

  return identifier;
}
