/**
 * HL7v2 PID Segment to FHIR Patient Mapping
 * Based on: HL7 Segment - FHIR R4_ PID[Patient] - PID.csv
 */

import type { PID, CWE, CE } from "@health-samurai/interbox/hl7v2";
import type {
  Patient,
  PatientCommunication,
  Identifier,
  HumanName,
  Address,
  ContactPoint,
  CodeableConcept,
  Extension,
} from "@health-samurai/interbox/fhir/4.0.1";
import { domainError } from "@health-samurai/interbox";
import { convertCXToIdentifier } from "../datatypes/cx-identifier.ts";
import { convertXPNToHumanName, convertXPNToString } from "../datatypes/xpn-humanname.ts";
import { convertXADToAddress } from "../datatypes/xad-address.ts";
import { convertXTNToContactPoint } from "../datatypes/xtn-contactpoint.ts";
import { convertCWEToCodeableConcept } from "../datatypes/cwe-codeableconcept.ts";
import { convertCEToCodeableConcept } from "../datatypes/ce-codeableconcept.ts";
import { convertDLNToIdentifier } from "../datatypes/dln-identifier.ts";
import { convertIDToBoolean } from "../datatypes/id-converters.ts";

// ============================================================================
// Extension URLs
// ============================================================================

const EXT_MOTHERS_MAIDEN_NAME = "http://hl7.org/fhir/StructureDefinition/patient-mothersMaidenName";
const EXT_BIRTH_TIME = "http://hl7.org/fhir/StructureDefinition/patient-birthTime";
const EXT_RELIGION = "http://hl7.org/fhir/StructureDefinition/patient-religion";
const EXT_BIRTH_PLACE = "http://hl7.org/fhir/StructureDefinition/patient-birthPlace";
const EXT_CITIZENSHIP = "http://hl7.org/fhir/StructureDefinition/patient-citizenship";
const EXT_NATIONALITY = "http://hl7.org/fhir/StructureDefinition/patient-nationality";
const EXT_ANIMAL = "http://hl7.org/fhir/StructureDefinition/patient-animal";

// ============================================================================
// Code Systems
// ============================================================================

const SSN_TYPE_SYSTEM = "http://terminology.hl7.org/CodeSystem/v2-0203";
const SSN_SYSTEM = "http://hl7.org/fhir/sid/us-ssn";

// ============================================================================
// Gender Mapping (HL7 Table 0001 -> FHIR AdministrativeSex)
// ============================================================================

const GENDER_MAP: Record<string, Patient["gender"]> = {
  M: "male",
  F: "female",
  O: "other",
  U: "unknown",
  A: "other",     // Ambiguous
  N: "unknown",   // Not applicable
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Convert HL7v2 DTM to FHIR date (YYYY-MM-DD)
 */
function convertDTMToDate(dtm: string | undefined): string | undefined {
  if (!dtm) {return undefined;}
  if (dtm.length < 8) {return undefined;}

  const year = dtm.substring(0, 4);
  const month = dtm.substring(4, 6);
  const day = dtm.substring(6, 8);

  return `${year}-${month}-${day}`;
}

/**
 * Convert HL7v2 DTM to FHIR dateTime
 */
function convertDTMToDateTime(dtm: string | undefined): string | undefined {
  if (!dtm) {return undefined;}

  const year = dtm.substring(0, 4);
  const month = dtm.substring(4, 6);
  const day = dtm.substring(6, 8);
  const hour = dtm.substring(8, 10);
  const minute = dtm.substring(10, 12);
  const second = dtm.substring(12, 14);

  if (dtm.length === 4) {return year;}
  if (dtm.length === 6) {return `${year}-${month}`;}
  if (dtm.length === 8) {return `${year}-${month}-${day}`;}
  if (dtm.length >= 12) {
    const base = `${year}-${month}-${day}T${hour}:${minute}`;
    if (dtm.length >= 14) {return `${base}:${second}`;}
    return `${base}:00`;
  }

  return dtm;
}

/**
 * Convert CE to CodeableConcept (CE is similar to CWE but older)
 */
function convertCEOrCWEToCodeableConcept(
  value: CE | CWE | undefined
): CodeableConcept | undefined {
  if (!value) {return undefined;}
  // CE and CWE have compatible structures for basic conversion
  return convertCEToCodeableConcept(value as CE);
}

// ============================================================================
// Main Converter Function
// ============================================================================

/**
 * Convert HL7v2 PID segment to FHIR Patient
 *
 * Field Mappings:
 * - PID-2  -> identifier[1] (Patient ID)
 * - PID-3  -> identifier[2] (Patient Identifier List)
 * - PID-4  -> identifier[3] (Alternate Patient ID)
 * - PID-5  -> name[1] (Patient Name)
 * - PID-6  -> extension (Mother's Maiden Name)
 * - PID-7  -> birthDate, extension (Birth Time if > 8 chars)
 * - PID-8  -> gender
 * - PID-9  -> name[2] (Patient Alias)
 * - PID-11 -> address[1]
 * - PID-12 -> address.district (County Code)
 * - PID-13 -> telecom[1] (Home Phone)
 * - PID-14 -> telecom[2] (Business Phone)
 * - PID-15 -> communication.language
 * - PID-16 -> maritalStatus
 * - PID-17 -> extension (Religion)
 * - PID-19 -> identifier[4] (SSN)
 * - PID-20 -> identifier[5] (Driver's License)
 * - PID-23 -> extension (Birth Place)
 * - PID-24 -> multipleBirthBoolean (if PID-25 not valued)
 * - PID-25 -> multipleBirthInteger
 * - PID-26 -> extension (Citizenship)
 * - PID-28 -> extension (Nationality)
 * - PID-29 -> deceasedDateTime
 * - PID-30 -> deceasedBoolean (if PID-29 not valued)
 * - PID-35 -> extension (Species - Animal)
 * - PID-36 -> extension (Breed - Animal)
 * - PID-39 -> extension (Tribal Citizenship)
 */
export function convertPIDToPatient(pid: PID): Patient {
  const patient: Patient = {
    resourceType: "Patient",
  };

  // =========================================================================
  // Identifiers
  // =========================================================================

  const identifiers: Identifier[] = [];

  // PID-2: Patient ID -> identifier[1]
  if (pid.$2_patientId) {
    const id = convertCXToIdentifier(pid.$2_patientId);
    if (id) {identifiers.push(id);}
  }

  // PID-3: Patient Identifier List -> identifier[2]
  if (pid.$3_identifier) {
    for (const cx of pid.$3_identifier) {
      const id = convertCXToIdentifier(cx);
      if (id) {identifiers.push(id);}
    }
  }

  // PID-4: Alternate Patient ID -> identifier[3]
  if (pid.$4_alternatePatientIdPid) {
    for (const cx of pid.$4_alternatePatientIdPid) {
      const id = convertCXToIdentifier(cx);
      if (id) {identifiers.push(id);}
    }
  }

  // PID-19: SSN Number -> identifier[4]
  if (pid.$19_ssnNumberPatient) {
    identifiers.push({
      value: pid.$19_ssnNumberPatient,
      system: SSN_SYSTEM,
      type: {
        coding: [
          {
            system: SSN_TYPE_SYSTEM,
            code: "SS",
          },
        ],
      },
    });
  }

  // PID-20: Driver's License -> identifier[5]
  if (pid.$20_driversLicenseNumberPatient) {
    const dlId = convertDLNToIdentifier(pid.$20_driversLicenseNumberPatient);
    if (dlId) {identifiers.push(dlId);}
  }

  if (identifiers.length > 0) {
    patient.identifier = identifiers;
  }

  // =========================================================================
  // Names
  // =========================================================================

  const names: HumanName[] = [];

  // PID-5: Patient Name -> name[1]
  if (pid.$5_name) {
    for (const xpn of pid.$5_name) {
      const name = convertXPNToHumanName(xpn);
      if (name) {names.push(name);}
    }
  }

  // PID-9: Patient Alias -> name[2]
  if (pid.$9_alias) {
    for (const xpn of pid.$9_alias) {
      const name = convertXPNToHumanName(xpn);
      if (name) {
        name.use = "old"; // Alias typically treated as old/previous name
        names.push(name);
      }
    }
  }

  if (names.length > 0) {
    patient.name = names;
  }

  // =========================================================================
  // Birth Date and Time
  // =========================================================================

  // PID-7: Date/Time of Birth
  if (pid.$7_birthDate) {
    patient.birthDate = convertDTMToDate(pid.$7_birthDate);
  }

  // =========================================================================
  // Gender
  // =========================================================================

  // PID-8: Administrative Sex
  if (pid.$8_gender) {
    const genderCode = pid.$8_gender;
    const gender = GENDER_MAP[genderCode.toUpperCase()];
    if (!gender) {
      throw domainError(
        "code",
        "unmapped_gender",
        `PID-8 administrative sex "${genderCode}" is not in HL7 Table 0001 (expected M/F/O/U/A/N)`,
      );
    }
    patient.gender = gender;
  }

  // =========================================================================
  // Address
  // =========================================================================

  const addresses: Address[] = [];

  // PID-11: Patient Address -> address[1]
  if (pid.$11_address) {
    for (const xad of pid.$11_address) {
      const address = convertXADToAddress(xad);
      if (address) {addresses.push(address);}
    }
  }

  // PID-12: County Code -> address.district
  // Applied to first address if only one address, otherwise to second address slot
  if (pid.$12_countyCode) {
    if (addresses.length === 1 && addresses[0] && !addresses[0].district) {
      addresses[0].district = pid.$12_countyCode;
    } else if (addresses.length === 0) {
      addresses.push({ district: pid.$12_countyCode });
    }
  }

  if (addresses.length > 0) {
    patient.address = addresses;
  }

  // =========================================================================
  // Telecom
  // =========================================================================

  const telecoms: ContactPoint[] = [];

  // PID-13: Phone Number - Home -> telecom[1]
  if (pid.$13_homePhone) {
    for (const xtn of pid.$13_homePhone) {
      const telecom = convertXTNToContactPoint(xtn);
      if (telecom) {
        // Default to home if not specified
        if (!telecom.use) {telecom.use = "home";}
        telecoms.push(telecom);
      }
    }
  }

  // PID-14: Phone Number - Business -> telecom[2]
  if (pid.$14_businessPhone) {
    for (const xtn of pid.$14_businessPhone) {
      const telecom = convertXTNToContactPoint(xtn);
      if (telecom) {
        // Default to work if not specified
        if (!telecom.use) {telecom.use = "work";}
        telecoms.push(telecom);
      }
    }
  }

  if (telecoms.length > 0) {
    patient.telecom = telecoms;
  }

  // =========================================================================
  // Communication (Language)
  // =========================================================================

  // PID-15: Primary Language -> communication.language
  if (pid.$15_language) {
    const languageCode = convertCEOrCWEToCodeableConcept(pid.$15_language);
    if (languageCode) {
      const communication: PatientCommunication = {
        language: languageCode,
        preferred: true, // Primary language is preferred
      };
      patient.communication = [communication];
    }
  }

  // =========================================================================
  // Marital Status
  // =========================================================================

  // PID-16: Marital Status
  if (pid.$16_maritalStatus) {
    const maritalStatus = convertCEOrCWEToCodeableConcept(pid.$16_maritalStatus);
    if (maritalStatus) {
      patient.maritalStatus = maritalStatus;
    }
  }

  // =========================================================================
  // Multiple Birth
  // =========================================================================

  // PID-25: Birth Order -> multipleBirthInteger
  if (pid.$25_birthOrder) {
    const birthOrder = parseInt(pid.$25_birthOrder, 10);
    if (!isNaN(birthOrder)) {
      patient.multipleBirthInteger = birthOrder;
    }
  } else if (pid.$24_multipleBirthIndicator) {
    // PID-24: Multiple Birth Indicator -> multipleBirthBoolean (only if PID-25 not valued)
    const isMultiple = convertIDToBoolean(pid.$24_multipleBirthIndicator);
    if (isMultiple !== undefined) {
      patient.multipleBirthBoolean = isMultiple;
    }
  }

  // =========================================================================
  // Deceased
  // =========================================================================

  // PID-29: Patient Death Date and Time -> deceasedDateTime
  if (pid.$29_deceasedDateTime) {
    patient.deceasedDateTime = convertDTMToDateTime(pid.$29_deceasedDateTime);
  } else if (pid.$30_deceased) {
    // PID-30: Patient Death Indicator -> deceasedBoolean (only if PID-29 not valued)
    const isDeceased = convertIDToBoolean(pid.$30_deceased);
    if (isDeceased !== undefined) {
      patient.deceasedBoolean = isDeceased;
    }
  }

  // =========================================================================
  // Extensions
  // =========================================================================

  const extensions: Extension[] = [];

  // PID-6: Mother's Maiden Name -> extension
  if (pid.$6_mothersMaidenName && pid.$6_mothersMaidenName.length > 0) {
    const maidenName = convertXPNToString(pid.$6_mothersMaidenName[0]);
    if (maidenName) {
      extensions.push({
        url: EXT_MOTHERS_MAIDEN_NAME,
        valueString: maidenName,
      });
    }
  }

  // PID-7: Birth Time extension (if length > 8)
  if (pid.$7_birthDate && pid.$7_birthDate.length > 8) {
    const birthTime = convertDTMToDateTime(pid.$7_birthDate);
    if (birthTime) {
      extensions.push({
        url: EXT_BIRTH_TIME,
        valueDateTime: birthTime,
      });
    }
  }

  // PID-17: Religion -> extension
  if (pid.$17_religion) {
    const religionCode = convertCEOrCWEToCodeableConcept(pid.$17_religion);
    if (religionCode) {
      extensions.push({
        url: EXT_RELIGION,
        valueCodeableConcept: religionCode,
      });
    }
  }

  // PID-23: Birth Place -> extension
  if (pid.$23_birthPlace) {
    extensions.push({
      url: EXT_BIRTH_PLACE,
      valueAddress: {
        text: pid.$23_birthPlace,
      },
    });
  }

  // PID-26: Citizenship -> extension
  if (pid.$26_citizenship && pid.$26_citizenship.length > 0) {
    for (const citizenship of pid.$26_citizenship) {
      const citizenshipCode = convertCEOrCWEToCodeableConcept(citizenship);
      if (citizenshipCode) {
        extensions.push({
          url: EXT_CITIZENSHIP,
          extension: [
            {
              url: "code",
              valueCodeableConcept: citizenshipCode,
            },
          ],
        });
      }
    }
  }

  // PID-28: Nationality -> extension
  if (pid.$28_nationality) {
    const nationalityCode = convertCEOrCWEToCodeableConcept(pid.$28_nationality);
    if (nationalityCode) {
      extensions.push({
        url: EXT_NATIONALITY,
        extension: [
          {
            url: "code",
            valueCodeableConcept: nationalityCode,
          },
        ],
      });
    }
  }

  // PID-35: Species Code (Animal) -> extension
  // PID-36: Breed Code (Animal) -> extension
  if (pid.$35_speciesCode || pid.$36_breedCode) {
    const animalExtensions: Extension[] = [];

    if (pid.$35_speciesCode) {
      const speciesCode = convertCEOrCWEToCodeableConcept(pid.$35_speciesCode);
      if (speciesCode) {
        animalExtensions.push({
          url: "species",
          valueCodeableConcept: speciesCode,
        });
      }
    }

    if (pid.$36_breedCode) {
      const breedCode = convertCEOrCWEToCodeableConcept(pid.$36_breedCode);
      if (breedCode) {
        animalExtensions.push({
          url: "breed",
          valueCodeableConcept: breedCode,
        });
      }
    }

    if (animalExtensions.length > 0) {
      extensions.push({
        url: EXT_ANIMAL,
        extension: animalExtensions,
      });
    }
  }

  // PID-39: Tribal Citizenship -> extension
  if (pid.$39_tribalCitizenship && pid.$39_tribalCitizenship.length > 0) {
    for (const tribal of pid.$39_tribalCitizenship) {
      const tribalCode = convertCWEToCodeableConcept(tribal);
      if (tribalCode) {
        extensions.push({
          url: EXT_CITIZENSHIP,
          extension: [
            {
              url: "code",
              valueCodeableConcept: tribalCode,
            },
          ],
        });
      }
    }
  }

  if (extensions.length > 0) {
    patient.extension = extensions;
  }

  return patient;
}
