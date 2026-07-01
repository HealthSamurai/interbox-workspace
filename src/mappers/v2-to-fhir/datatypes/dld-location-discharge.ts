import type { DLD } from "@health-samurai/interbox/hl7v2";
import type { CodeableConcept } from "@health-samurai/interbox/fhir/4.0.1";

/** Partial Location data for discharge location */
interface LocationDischargeData {
  type?: CodeableConcept;
}

/**
 * Converts DLD (Discharge to Location and Date) to Location type data.
 *
 * Mapping:
 * - DLD.1 (Discharge to Location) -> type (CodeableConcept)
 * - DLD.2 (Effective Date) -> not mapped (use PV1-45 if available separately)
 *
 * Note: DLD.1 is typically a CWE in HL7v2 spec, but may be simplified to string
 * in some implementations. This function handles it as a code value.
 */
export function convertDLDToLocationDischarge(dld: DLD | undefined): LocationDischargeData | undefined {
  if (!dld) {return undefined;}
  if (!dld.$1_location) {return undefined;}

  return {
    type: {
      coding: [
        {
          code: dld.$1_location,
        },
      ],
    },
  };
}
