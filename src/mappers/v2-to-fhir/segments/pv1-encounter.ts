/**
 * HL7v2 PV1 Segment to FHIR Encounter Mapping
 * Based on: HL7 Segment - FHIR R4_ PV1[Encounter] - PV1.csv
 */

import type { PV1, XCN, PL, CWE, CE } from "@healthsamurai/interbox/hl7v2";
import type {
  Encounter,
  EncounterParticipant,
  EncounterLocation,
  EncounterHospitalization,
  Coding,
  CodeableConcept,
  Identifier,
  Extension,
} from "@healthsamurai/interbox/fhir/4.0.1";
import { domainError } from "@healthsamurai/interbox";
import { convertCXToIdentifier } from "../datatypes/cx-identifier.ts";
import { convertCEToCodeableConcept } from "../datatypes/ce-codeableconcept.ts";
import { convertXCNToPractitioner } from "../datatypes/xcn-practitioner.ts";
import { convertPLToLocation } from "../datatypes/pl-converters.ts";
import { convertDLDToLocationDischarge } from "../datatypes/dld-location-discharge.ts";

// ============================================================================
// Code Systems
// ============================================================================

const PARTICIPATION_TYPE_SYSTEM = "http://terminology.hl7.org/CodeSystem/v3-ParticipationType";
const ENCOUNTER_CLASS_SYSTEM = "http://terminology.hl7.org/CodeSystem/v3-ActCode";

// ============================================================================
// Patient Class Mapping (HL7 Table 0004 -> FHIR Encounter Class)
// ============================================================================

const PATIENT_CLASS_MAP: Record<string, { code: string; display: string }> = {
  // Standard HL7 Table 0004 codes
  E: { code: "EMER", display: "emergency" },
  I: { code: "IMP", display: "inpatient encounter" },
  O: { code: "AMB", display: "ambulatory" },
  P: { code: "PRENC", display: "pre-admission" },
  R: { code: "IMP", display: "inpatient encounter" },  // Recurring patient
  B: { code: "IMP", display: "inpatient encounter" },  // Obstetrics
  C: { code: "IMP", display: "inpatient encounter" },  // Commercial Account
  N: { code: "IMP", display: "inpatient encounter" },  // Not Applicable
  U: { code: "AMB", display: "ambulatory" },           // Unknown
};

// ============================================================================
// Patient Class to Status Mapping (when PV1-45 not valued)
// ============================================================================

const PATIENT_CLASS_STATUS_MAP: Record<string, Encounter["status"]> = {
  E: "in-progress",
  I: "in-progress",
  O: "in-progress",
  P: "planned",
  R: "in-progress",
  B: "in-progress",
  C: "in-progress",
  N: "unknown",
  U: "unknown",
};

/**
 * Map PV1-2 Patient Class to FHIR Encounter.class and status.
 *
 * Empty/absent PV1-2 defaults to "U" (Unknown). A non-empty PV1-2 outside
 * HL7 Table 0004 throws code/unmapped_patient_class.
 *
 * @param patientClass - The PV1-2 Patient Class value
 * @param hasDischargeDateTime - Whether PV1-45 (Discharge Date/Time) is valued
 */
export function mapPatientClassToFHIR(
  patientClass: string | undefined,
  hasDischargeDateTime = false,
): { class: Coding; status: Encounter["status"] } {
  // Normalize to uppercase for comparison
  const classCode = patientClass?.toUpperCase() || "U";

  const classMapping = PATIENT_CLASS_MAP[classCode];

  if (!classMapping) {
    throw domainError(
      "code",
      "unmapped_patient_class",
      `PV1-2 patient class "${patientClass}" is not in HL7 Table 0004`,
    );
  }

  // Build the class coding
  const encounterClass: Coding = {
    system: ENCOUNTER_CLASS_SYSTEM,
    code: classMapping.code,
    display: classMapping.display,
  };

  // Determine status
  const status: Encounter["status"] = hasDischargeDateTime
    ? "finished"
    : (PATIENT_CLASS_STATUS_MAP[classCode] || "unknown");

  return { class: encounterClass, status };
}

// ============================================================================
// Location Status Mapping
// ============================================================================

// Maps RESOLVED FHIR Encounter.class codes to location status
const LOCATION_STATUS_FOR_FHIR_CLASS: Record<string, EncounterLocation["status"]> = {
  PRENC: "planned",  // Pre-admission -> planned
};

// ============================================================================
// Extension URLs
// ============================================================================

const LOCATION_CLASSIFICATION_URL = "http://hl7.org/fhir/StructureDefinition/subject-locationClassification";

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Convert HL7v2 DTM to FHIR dateTime
 * HL7v2 format: YYYY[MM[DD[HH[MM[SS[.S[S[S[S]]]]]]]]][+/-ZZZZ]
 * FHIR requires timezone when time is present
 */
function convertDTMToDateTime(dtm: string | undefined): string | undefined {
  if (!dtm) {return undefined;}

  // Extract timezone if present (+/-ZZZZ at the end)
  const tzMatch = dtm.match(/([+-]\d{4})$/);
  const timezone = tzMatch && tzMatch[1] ? formatTimezone(tzMatch[1]) : "Z";
  const dtmWithoutTz = tzMatch ? dtm.slice(0, -5) : dtm;

  const year = dtmWithoutTz.substring(0, 4);
  const month = dtmWithoutTz.substring(4, 6);
  const day = dtmWithoutTz.substring(6, 8);
  const hour = dtmWithoutTz.substring(8, 10);
  const minute = dtmWithoutTz.substring(10, 12);
  const second = dtmWithoutTz.substring(12, 14);

  // Date-only formats don't need timezone
  if (dtmWithoutTz.length === 4) {return year;}
  if (dtmWithoutTz.length === 6) {return `${year}-${month}`;}
  if (dtmWithoutTz.length === 8) {return `${year}-${month}-${day}`;}

  // DateTime formats require timezone
  if (dtmWithoutTz.length >= 12) {
    const base = `${year}-${month}-${day}T${hour}:${minute}`;
    if (dtmWithoutTz.length >= 14) {return `${base}:${second}${timezone}`;}
    return `${base}:00${timezone}`;
  }

  return dtm;
}

/**
 * Format HL7 timezone (+/-ZZZZ) to ISO format (+/-HH:MM)
 */
function formatTimezone(tz: string): string {
  const sign = tz[0];
  const hours = tz.substring(1, 3);
  const minutes = tz.substring(3, 5);
  return `${sign}${hours}:${minutes}`;
}

/**
 * Convert CE or CWE to CodeableConcept
 */
function convertCEOrCWEToCodeableConcept(
  value: CE | CWE | string | undefined
): CodeableConcept | undefined {
  if (!value) {return undefined;}
  if (typeof value === "string") {
    return { coding: [{ code: value }] };
  }
  return convertCEToCodeableConcept(value as CE);
}

/**
 * Create a participant from XCN with a specific type
 */
function createParticipant(
  xcns: XCN[] | undefined,
  typeCode: string,
  typeDisplay: string
): EncounterParticipant[] {
  if (!xcns || xcns.length === 0) {return [];}

  const participants: EncounterParticipant[] = [];

  for (const xcn of xcns) {
    const practitioner = convertXCNToPractitioner(xcn);
    if (!practitioner) {continue;}

    // Create a contained reference or inline reference
    // For simplicity, we'll use display-only reference
    const participant: EncounterParticipant = {
      type: [
        {
          coding: [
            {
              system: PARTICIPATION_TYPE_SYSTEM,
              code: typeCode,
              display: typeDisplay,
            },
          ],
          text: typeDisplay,
        },
      ],
    };

    // Build a display name from practitioner
    const name = practitioner.name?.[0];
    if (name) {
      const displayParts: string[] = [];
      if (name.prefix) {displayParts.push(...name.prefix);}
      if (name.given) {displayParts.push(...name.given);}
      if (name.family) {displayParts.push(name.family);}
      if (name.suffix) {displayParts.push(...name.suffix);}

      if (displayParts.length > 0) {
        participant.individual = {
          display: displayParts.join(" "),
        };
      }
    }

    // If we have an identifier, add it
    if (practitioner.identifier?.[0]) {
      if (!participant.individual) {
        participant.individual = {};
      }
      participant.individual.identifier = practitioner.identifier[0];
    }

    if (participant.individual) {
      participants.push(participant);
    }
  }

  return participants;
}

/**
 * Create an EncounterLocation from PL data
 */
function createEncounterLocation(
  pl: PL | undefined,
  status: EncounterLocation["status"],
  extension?: Extension[]
): EncounterLocation | undefined {
  if (!pl) {return undefined;}

  const locationData = convertPLToLocation(pl);
  if (!locationData) {return undefined;}

  // Build a display name from location identifiers
  const displayParts: string[] = [];
  if (locationData.identifier) {
    for (const id of locationData.identifier) {
      if (id.value) {displayParts.push(id.value);}
    }
  }
  if (locationData.description) {
    displayParts.push(locationData.description);
  }

  const display = displayParts.length > 0 ? displayParts.join(" - ") : undefined;

  const encounterLocation: EncounterLocation = {
    location: {
      display,
    },
    status,
  };

  if (extension && extension.length > 0) {
    encounterLocation.extension = extension;
  }

  return encounterLocation;
}

// ============================================================================
// Core Builder Function
// ============================================================================

/**
 * Build FHIR Encounter from PV1 segment with pre-resolved class and status.
 *
 * The Encounter is returned without an id — the caller derives the
 * deterministic id (see support/identity.ts encounterIdFromPv1) and decides
 * whether a missing PV1-19 value is an error.
 *
 * Field Mappings:
 * - PV1-3  -> location[1] (Assigned Patient Location)
 * - PV1-4  -> type (Admission Type)
 * - PV1-5  -> hospitalization.preAdmissionIdentifier
 * - PV1-6  -> location[2] (Prior Patient Location, status=completed)
 * - PV1-7  -> participant (Attending Doctor, type=ATND)
 * - PV1-8  -> participant (Referring Doctor, type=REF)
 * - PV1-9  -> participant (Consulting Doctor, type=CON)
 * - PV1-10 -> serviceType
 * - PV1-11 -> location[3] (Temporary Location, status=active)
 * - PV1-13 -> hospitalization.reAdmission
 * - PV1-14 -> hospitalization.admitSource
 * - PV1-15 -> hospitalization.specialArrangement
 * - PV1-16 -> hospitalization.specialCourtesy
 * - PV1-17 -> participant (Admitting Doctor, type=ADM)
 * - PV1-19 -> identifier (Visit Number, type=VN)
 * - PV1-36 -> hospitalization.dischargeDisposition
 * - PV1-37 -> hospitalization.destination
 * - PV1-38 -> hospitalization.dietPreference
 * - PV1-42 -> location[4] (Pending Location, status=reserved)
 * - PV1-44 -> period.start
 * - PV1-45 -> period.end
 * - PV1-50 -> identifier (Alternate Visit ID)
 *
 * @param pv1 - The PV1 segment to convert
 * @param encounterClass - Pre-resolved FHIR Encounter.class coding
 * @param status - Pre-resolved Encounter.status
 */
export function buildEncounterFromPV1(
  pv1: PV1,
  encounterClass: Coding,
  status: Encounter["status"],
): Encounter {
  const encounter: Encounter = {
    resourceType: "Encounter",
    class: encounterClass,
    status,
  };

  // Determine location status for assigned location based on resolved class
  const resolvedFhirClassCode = encounterClass.code ?? "";
  const assignedLocationStatus: EncounterLocation["status"] =
    LOCATION_STATUS_FOR_FHIR_CLASS[resolvedFhirClassCode] || "active";

  // =========================================================================
  // Identifiers
  // =========================================================================

  const identifiers: Identifier[] = [];

  // PV1-19: Visit Number -> identifier with type=VN
  const visitNumber = pv1.$19_visitNumber;
  if (visitNumber?.$1_value) {
    // Prefer Universal ID (HD.2), fall back to Namespace ID (HD.1)
    const system =
      visitNumber.$4_system?.$2_system?.trim() ||
      visitNumber.$4_system?.$1_namespace?.trim();
    identifiers.push({
      ...(system && { system }),
      value: visitNumber.$1_value,
      type: {
        coding: [
          {
            system: "http://terminology.hl7.org/CodeSystem/v2-0203",
            code: "VN",
            display: "Visit Number",
          },
        ],
      },
    });
  }

  // PV1-50: Alternate Visit ID -> identifier
  if (pv1.$50_alternateVisitId) {
    const altId = convertCXToIdentifier(pv1.$50_alternateVisitId);
    if (altId) {identifiers.push(altId);}
  }

  if (identifiers.length > 0) {
    encounter.identifier = identifiers;
  }

  // =========================================================================
  // Type
  // =========================================================================

  // PV1-4: Admission Type -> type
  if (pv1.$4_admissionType) {
    const admissionType = convertCEOrCWEToCodeableConcept(pv1.$4_admissionType);
    if (admissionType) {
      encounter.type = [admissionType];
    }
  }

  // =========================================================================
  // Service Type
  // =========================================================================

  // PV1-10: Hospital Service -> serviceType
  if (pv1.$10_hospitalService) {
    const serviceType = convertCEOrCWEToCodeableConcept(pv1.$10_hospitalService);
    if (serviceType) {
      encounter.serviceType = serviceType;
    }
  }

  // =========================================================================
  // Period
  // =========================================================================

  // PV1-44: Admit Date/Time -> period.start
  // PV1-45: Discharge Date/Time -> period.end
  const periodStart = convertDTMToDateTime(pv1.$44_admission);
  const periodEnd = convertDTMToDateTime(pv1.$45_discharge?.[0]);

  if (periodStart || periodEnd) {
    encounter.period = {
      ...(periodStart && { start: periodStart }),
      ...(periodEnd && { end: periodEnd }),
    };
  }

  // =========================================================================
  // Participants
  // =========================================================================

  const participants: EncounterParticipant[] = [];

  // PV1-7: Attending Doctor -> participant with type=ATND
  participants.push(...createParticipant(pv1.$7_attendingDoctor, "ATND", "attender"));

  // PV1-8: Referring Doctor -> participant with type=REF
  participants.push(...createParticipant(pv1.$8_referringDoctor, "REF", "referrer"));

  // PV1-9: Consulting Doctor -> participant with type=CON
  participants.push(...createParticipant(pv1.$9_consultingDoctor, "CON", "consultant"));

  // PV1-17: Admitting Doctor -> participant with type=ADM
  participants.push(...createParticipant(pv1.$17_admittingDoctor, "ADM", "admitter"));

  if (participants.length > 0) {
    encounter.participant = participants;
  }

  // =========================================================================
  // Locations
  // =========================================================================

  const locations: EncounterLocation[] = [];

  // PV1-3: Assigned Patient Location -> location[1]
  const assignedLocation = createEncounterLocation(
    pv1.$3_assignedPatientLocation,
    assignedLocationStatus
  );
  if (assignedLocation) {locations.push(assignedLocation);}

  // PV1-6: Prior Patient Location -> location[2] with status=completed
  const priorLocation = createEncounterLocation(
    pv1.$6_priorPatientLocation,
    "completed"
  );
  if (priorLocation) {locations.push(priorLocation);}

  // PV1-11: Temporary Location -> location[3] with status=active and extension
  if (pv1.$11_temporaryLocation) {
    const tempExtension: Extension[] = [
      {
        url: LOCATION_CLASSIFICATION_URL,
        valueCodeableConcept: {
          coding: [
            {
              system: "http://hl7.org/fhir/ValueSet/subject-location",
              code: "temporary",
            },
          ],
        },
      },
    ];
    const tempLocation = createEncounterLocation(
      pv1.$11_temporaryLocation,
      "active",
      tempExtension
    );
    if (tempLocation) {locations.push(tempLocation);}
  }

  // PV1-42: Pending Location -> location[4] with status=reserved
  const pendingLocation = createEncounterLocation(
    pv1.$42_pendingLocation,
    "reserved"
  );
  if (pendingLocation) {locations.push(pendingLocation);}

  if (locations.length > 0) {
    encounter.location = locations;
  }

  // =========================================================================
  // Hospitalization
  // =========================================================================

  const hospitalization: EncounterHospitalization = {};
  let hasHospitalization = false;

  // PV1-5: Preadmit Number -> hospitalization.preAdmissionIdentifier
  if (pv1.$5_preadmitNumber) {
    const preAdmitId = convertCXToIdentifier(pv1.$5_preadmitNumber);
    if (preAdmitId) {
      hospitalization.preAdmissionIdentifier = preAdmitId;
      hasHospitalization = true;
    }
  }

  // PV1-13: Re-admission Indicator -> hospitalization.reAdmission
  if (pv1.$13_reAdmissionIndicator) {
    const reAdmission = convertCEOrCWEToCodeableConcept(pv1.$13_reAdmissionIndicator);
    if (reAdmission) {
      hospitalization.reAdmission = reAdmission;
      hasHospitalization = true;
    }
  }

  // PV1-14: Admit Source -> hospitalization.admitSource
  if (pv1.$14_admitSource) {
    hospitalization.admitSource = {
      coding: [{ code: pv1.$14_admitSource }],
    };
    hasHospitalization = true;
  }

  // PV1-15: Ambulatory Status -> hospitalization.specialArrangement
  if (pv1.$15_ambulatoryStatus && pv1.$15_ambulatoryStatus.length > 0) {
    const specialArrangements: CodeableConcept[] = [];
    for (const status of pv1.$15_ambulatoryStatus) {
      const arrangement = convertCEOrCWEToCodeableConcept(status);
      if (arrangement) {specialArrangements.push(arrangement);}
    }
    if (specialArrangements.length > 0) {
      hospitalization.specialArrangement = specialArrangements;
      hasHospitalization = true;
    }
  }

  // PV1-16: VIP Indicator -> hospitalization.specialCourtesy
  if (pv1.$16_vip) {
    hospitalization.specialCourtesy = [
      {
        coding: [{ code: pv1.$16_vip }],
      },
    ];
    hasHospitalization = true;
  }

  // PV1-36: Discharge Disposition -> hospitalization.dischargeDisposition
  if (pv1.$36_dischargeDisposition) {
    hospitalization.dischargeDisposition = {
      coding: [{ code: pv1.$36_dischargeDisposition }],
    };
    hasHospitalization = true;
  }

  // PV1-37: Discharged to Location -> hospitalization.destination
  if (pv1.$37_dischargedToLocation) {
    const dischargeLocation = convertDLDToLocationDischarge(pv1.$37_dischargedToLocation);
    if (dischargeLocation?.type) {
      hospitalization.destination = {
        display: dischargeLocation.type.coding?.[0]?.code,
      };
      hasHospitalization = true;
    }
  }

  // PV1-38: Diet Type -> hospitalization.dietPreference
  if (pv1.$38_dietType) {
    const dietPreference = convertCEToCodeableConcept(pv1.$38_dietType);
    if (dietPreference) {
      hospitalization.dietPreference = [dietPreference];
      hasHospitalization = true;
    }
  }

  if (hasHospitalization) {
    encounter.hospitalization = hospitalization;
  }

  return encounter;
}

/**
 * Convert PV1 segment to FHIR Encounter.
 *
 * Resolves PV1-2 Patient Class via the hardcoded HL7 Table 0004 map (throws
 * code/unmapped_patient_class for unmapped non-empty values), then builds
 * the Encounter. The caller assigns the deterministic id and subject.
 */
export function convertPV1ToEncounter(pv1: PV1): Encounter {
  const hasDischargeDateTime = !!(pv1.$45_discharge?.[0]);
  const classCode = extractPatientClass(pv1);

  const { class: encounterClass, status } = mapPatientClassToFHIR(
    classCode,
    hasDischargeDateTime,
  );

  return buildEncounterFromPV1(pv1, encounterClass, status);
}

/**
 * Extract and normalize patient class from PV1-2.
 * Returns uppercase code, defaults to "U" (Unknown) if not present.
 */
export function extractPatientClass(pv1: PV1): string {
  if (!pv1.$2_class) {return "U";}

  if (typeof pv1.$2_class === "string") {
    return pv1.$2_class.toUpperCase();
  }

  const maybeStringLike = pv1.$2_class as unknown as { toUpperCase?: () => string };
  if (typeof maybeStringLike.toUpperCase === "function") {
    return maybeStringLike.toUpperCase();
  }

  return "U";
}
