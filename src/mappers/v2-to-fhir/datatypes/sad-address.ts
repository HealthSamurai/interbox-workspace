/**
 * HL7v2 SAD to FHIR Address Mapping
 * Based on: HL7 Data Type - FHIR R4_ SAD[Address]
 */

import type { SAD } from "@healthsamurai/interbox/hl7v2";
import type { Address } from "@healthsamurai/interbox/fhir/4.0.1";

/**
 * Convert HL7v2 SAD (Street Address) to FHIR Address
 *
 * Mapping:
 * - SAD.1 (Street or Mailing Address) -> line[0]
 * - SAD.2 (Street Name) -> line[1]
 * - SAD.3 (Dwelling Number) -> line[2]
 */
export function convertSADToAddress(sad: SAD | undefined): Address | undefined {
  if (!sad) {return undefined;}

  const line: string[] = [];

  if (sad.$1_line) {line.push(sad.$1_line);}
  if (sad.$2_streetName) {line.push(sad.$2_streetName);}
  if (sad.$3_houseNumber) {line.push(sad.$3_houseNumber);}

  if (line.length === 0) {return undefined;}

  return { line };
}
