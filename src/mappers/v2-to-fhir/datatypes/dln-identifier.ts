import type { DLN } from "@healthsamurai/interbox/hl7v2";
import type { Identifier } from "@healthsamurai/interbox/fhir/4.0.1";

const DRIVER_LICENSE_TYPE_SYSTEM = "http://terminology.hl7.org/CodeSystem/v2-0203";
const DRIVER_LICENSE_TYPE_CODE = "DL";

/**
 * Converts DLN (Driver's License Number) to FHIR Identifier.
 *
 * Mapping:
 * - DLN.1 (License Number) -> value
 * - DLN.1 also sets type.coding[0].code = "DL" and type.coding[0].system
 * - DLN.2 (Issuing State, Province, Country) -> system
 * - DLN.3 (Expiration Date) -> period.end
 */
export function convertDLNToIdentifier(dln: DLN | undefined): Identifier | undefined {
  if (!dln) {return undefined;}
  if (!dln.$1_license) {return undefined;}

  const identifier: Identifier = {
    value: dln.$1_license,
    type: {
      coding: [
        {
          system: DRIVER_LICENSE_TYPE_SYSTEM,
          code: DRIVER_LICENSE_TYPE_CODE,
        },
      ],
    },
  };

  // Map issuing authority to system
  if (dln.$2_issuingAuthority) {
    identifier.system = dln.$2_issuingAuthority;
  }

  // Map expiration date to period.end
  if (dln.$3_end) {
    identifier.period = {
      end: dln.$3_end,
    };
  }

  return identifier;
}
