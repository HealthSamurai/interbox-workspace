/**
 * HL7v2 NK1 Segment to FHIR RelatedPerson Mapping
 * Based on: HL7 Segment - FHIR R4_ NK1[RelatedPerson] - Sheet1.csv
 */

import type { NK1 } from "@healthsamurai/interbox/hl7v2";
import type {
  RelatedPerson,
  RelatedPersonCommunication,
  CodeableConcept,
  Identifier,
  HumanName,
  Address,
  ContactPoint,
  Period,
} from "@healthsamurai/interbox/fhir/4.0.1";
import { convertCXToIdentifier } from "../datatypes/cx-identifier.ts";
import { convertCEToCodeableConcept } from "../datatypes/ce-codeableconcept.ts";
import { convertXPNToHumanName } from "../datatypes/xpn-humanname.ts";
import { convertXADToAddress } from "../datatypes/xad-address.ts";
import { convertXTNToContactPoint } from "../datatypes/xtn-contactpoint.ts";

// ============================================================================
// Code Systems
// ============================================================================

const SSN_SYSTEM = "http://hl7.org/fhir/sid/us-ssn";

// ============================================================================
// Gender Mapping (HL7 Table 0001 -> FHIR AdministrativeSex)
// ============================================================================

const GENDER_MAP: Record<string, RelatedPerson["gender"]> = {
  M: "male",
  F: "female",
  O: "other",
  U: "unknown",
  A: "other",
  N: "unknown",
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Convert HL7v2 DT to FHIR date (YYYY-MM-DD)
 */
function convertDTToDate(dt: string | undefined): string | undefined {
  if (!dt) {return undefined;}
  if (dt.length < 8) {return undefined;}

  const year = dt.substring(0, 4);
  const month = dt.substring(4, 6);
  const day = dt.substring(6, 8);

  return `${year}-${month}-${day}`;
}

// ============================================================================
// Main Converter Function
// ============================================================================

/**
 * Convert HL7v2 NK1 segment to FHIR RelatedPerson
 *
 * Field Mappings:
 * - NK1-2  -> name[1] (Name)
 * - NK1-3  -> relationship[1] (Relationship)
 * - NK1-4  -> address[1] (Address)
 * - NK1-5  -> telecom[1] (Phone Number)
 * - NK1-6  -> telecom[2] with use="work" (Business Phone)
 * - NK1-7  -> relationship[2] (Contact Role)
 * - NK1-8  -> period.start (Start Date)
 * - NK1-9  -> period.end (End Date)
 * - NK1-12 -> identifier[1] (Employee Number)
 * - NK1-15 -> gender (Administrative Sex)
 * - NK1-16 -> birthDate (Date/Time of Birth)
 * - NK1-20 -> communication.language (Primary Language)
 * - NK1-30 -> name[2] (Contact Person's Name)
 * - NK1-31 -> telecom[3] (Contact Person's Phone)
 * - NK1-32 -> address[2] (Contact Person's Address)
 * - NK1-33 -> identifier[2] (Associated Party's Identifiers)
 * - NK1-37 -> identifier[3] with system=SSN (Contact Person SSN)
 */
export function convertNK1ToRelatedPerson(nk1: NK1): Omit<RelatedPerson, "patient"> & { patient: { reference?: string } } {
  const relatedPerson: Omit<RelatedPerson, "patient"> & { patient: { reference?: string } } = {
    resourceType: "RelatedPerson",
    patient: {}, // Must be set by caller
  };

  // =========================================================================
  // Names
  // =========================================================================

  const names: HumanName[] = [];

  // NK1-2: Name -> name[1]
  if (nk1.$2_name) {
    for (const xpn of nk1.$2_name) {
      const name = convertXPNToHumanName(xpn);
      if (name) {names.push(name);}
    }
  }

  // NK1-30: Contact Person's Name -> name[2]
  if (nk1.$30_contactPersonsName) {
    for (const xpn of nk1.$30_contactPersonsName) {
      const name = convertXPNToHumanName(xpn);
      if (name) {names.push(name);}
    }
  }

  if (names.length > 0) {
    relatedPerson.name = names;
  }

  // =========================================================================
  // Relationships
  // =========================================================================

  const relationships: CodeableConcept[] = [];

  // NK1-3: Relationship -> relationship[1]
  if (nk1.$3_relationship) {
    const relationship = convertCEToCodeableConcept(nk1.$3_relationship);
    if (relationship) {relationships.push(relationship);}
  }

  // NK1-7: Contact Role -> relationship[2]
  if (nk1.$7_contactRole) {
    const contactRole = convertCEToCodeableConcept(nk1.$7_contactRole);
    if (contactRole) {relationships.push(contactRole);}
  }

  if (relationships.length > 0) {
    relatedPerson.relationship = relationships;
  }

  // =========================================================================
  // Addresses
  // =========================================================================

  const addresses: Address[] = [];

  // NK1-4: Address -> address[1]
  if (nk1.$4_text) {
    for (const xad of nk1.$4_text) {
      const address = convertXADToAddress(xad);
      if (address) {addresses.push(address);}
    }
  }

  // NK1-32: Contact Person's Address -> address[2]
  if (nk1.$32_contactPersonsAddress) {
    for (const xad of nk1.$32_contactPersonsAddress) {
      const address = convertXADToAddress(xad);
      if (address) {addresses.push(address);}
    }
  }

  if (addresses.length > 0) {
    relatedPerson.address = addresses;
  }

  // =========================================================================
  // Telecom
  // =========================================================================

  const telecoms: ContactPoint[] = [];

  // NK1-5: Phone Number -> telecom[1]
  if (nk1.$5_phone) {
    for (const xtn of nk1.$5_phone) {
      const telecom = convertXTNToContactPoint(xtn);
      if (telecom) {telecoms.push(telecom);}
    }
  }

  // NK1-6: Business Phone Number -> telecom[2] with use="work"
  if (nk1.$6_businessPhone) {
    for (const xtn of nk1.$6_businessPhone) {
      const telecom = convertXTNToContactPoint(xtn);
      if (telecom) {
        telecom.use = "work";
        telecoms.push(telecom);
      }
    }
  }

  // NK1-31: Contact Person's Telephone Number -> telecom[3]
  if (nk1.$31_contactPhone) {
    for (const xtn of nk1.$31_contactPhone) {
      const telecom = convertXTNToContactPoint(xtn);
      if (telecom) {telecoms.push(telecom);}
    }
  }

  if (telecoms.length > 0) {
    relatedPerson.telecom = telecoms;
  }

  // =========================================================================
  // Period
  // =========================================================================

  // NK1-8: Start Date -> period.start
  // NK1-9: End Date -> period.end
  const periodStart = convertDTToDate(nk1.$8_startDate);
  const periodEnd = convertDTToDate(nk1.$9_endDate);

  if (periodStart || periodEnd) {
    const period: Period = {};
    if (periodStart) {period.start = periodStart;}
    if (periodEnd) {period.end = periodEnd;}
    relatedPerson.period = period;
  }

  // =========================================================================
  // Identifiers
  // =========================================================================

  const identifiers: Identifier[] = [];

  // NK1-12: Employee Number -> identifier[1]
  if (nk1.$12_nextOfKinAssociatedPartiesEmployeeNumber) {
    const empId = convertCXToIdentifier(nk1.$12_nextOfKinAssociatedPartiesEmployeeNumber);
    if (empId) {identifiers.push(empId);}
  }

  // NK1-33: Associated Party's Identifiers -> identifier[2]
  if (nk1.$33_nextOfKinAssociatedPartysIdentifiers) {
    for (const cx of nk1.$33_nextOfKinAssociatedPartysIdentifiers) {
      const id = convertCXToIdentifier(cx);
      if (id) {identifiers.push(id);}
    }
  }

  // NK1-37: Contact Person Social Security Number -> identifier[3]
  if (nk1.$37_contactPersonSocialSecurityNumber) {
    identifiers.push({
      value: nk1.$37_contactPersonSocialSecurityNumber,
      system: SSN_SYSTEM,
      type: {
        coding: [
          {
            system: "http://terminology.hl7.org/CodeSystem/v2-0203",
            code: "SS",
          },
        ],
      },
    });
  }

  if (identifiers.length > 0) {
    relatedPerson.identifier = identifiers;
  }

  // =========================================================================
  // Gender
  // =========================================================================

  // NK1-15: Administrative Sex -> gender
  if (nk1.$15_gender) {
    const genderCode = typeof nk1.$15_gender === "string"
      ? nk1.$15_gender
      : String(nk1.$15_gender);
    relatedPerson.gender = GENDER_MAP[genderCode.toUpperCase()];
  }

  // =========================================================================
  // Birth Date
  // =========================================================================

  // NK1-16: Date/Time of Birth -> birthDate
  if (nk1.$16_birthDate) {
    relatedPerson.birthDate = convertDTToDate(nk1.$16_birthDate);
  }

  // =========================================================================
  // Communication
  // =========================================================================

  // NK1-20: Primary Language -> communication.language
  if (nk1.$20_language) {
    const languageCode = convertCEToCodeableConcept(nk1.$20_language);
    if (languageCode) {
      const communication: RelatedPersonCommunication = {
        language: languageCode,
        preferred: true,
      };
      relatedPerson.communication = [communication];
    }
  }

  return relatedPerson;
}
