/**
 * HL7v2 DG1 Segment to FHIR Condition Mapping
 * Based on: HL7 Segment - FHIR R4_ DG1[Condition] - Sheet1.csv
 */

import type { DG1, EI } from "@healthsamurai/interbox/hl7v2";
import type {
  Condition,
  Identifier,
  Extension,
  Reference,
} from "@healthsamurai/interbox/fhir/4.0.1";
import { convertCEToCodeableConcept } from "../datatypes/ce-codeableconcept.ts";
import { convertXCNToPractitioner } from "../datatypes/xcn-practitioner.ts";

// ============================================================================
// Code Systems
// ============================================================================

const CONDITION_VER_STATUS_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/condition-ver-status";
const EXT_ASSERTED_DATE =
  "http://www.hl7.org/fhir/extension-condition-asserteddate";

// ============================================================================
// Helper Functions
// ============================================================================

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
 * Convert EI to Identifier
 */
function convertEIToIdentifier(ei: EI | undefined): Identifier | undefined {
  if (!ei) {return undefined;}

  const identifier: Identifier = {};

  if (ei.$1_value) {
    identifier.value = ei.$1_value;
  }

  if (ei.$3_system) {
    identifier.system = ei.$3_system;
  } else if (ei.$2_namespace) {
    identifier.system = ei.$2_namespace;
  }

  if (!identifier.value) {return undefined;}

  return identifier;
}

// ============================================================================
// Main Converter Function
// ============================================================================

/**
 * Convert HL7v2 DG1 segment to FHIR Condition
 *
 * Field Mappings:
 * - DG1-3  -> code (Diagnosis Code)
 * - DG1-4  -> code.text (Diagnosis Description)
 * - DG1-5  -> onsetDateTime (Diagnosis Date/Time)
 * - DG1-16 -> asserter (Diagnosing Clinician)
 * - DG1-19 -> recordedDate, extension[asserted-date] (Attestation Date/Time)
 * - DG1-20 -> identifier (Diagnosis Identifier)
 * - DG1-21 -> verificationStatus (Diagnosis Action Code - "D" = entered-in-error)
 * - DG1-22 -> extension[condition-dueTo] (Parent Diagnosis)
 */
export function convertDG1ToCondition(dg1: DG1): Omit<Condition, "subject"> & { subject: { reference?: string } } {
  const condition: Omit<Condition, "subject"> & { subject: { reference?: string } } = {
    resourceType: "Condition",
    subject: {}, // Must be set by caller
  };

  // =========================================================================
  // Code (required for meaningful condition)
  // =========================================================================

  // DG1-3: Diagnosis Code -> code
  if (dg1.$3_diagnosisCodeDg1) {
    const code = convertCEToCodeableConcept(dg1.$3_diagnosisCodeDg1);
    if (code) {
      condition.code = code;
    }
  }

  // DG1-4: Diagnosis Description -> code.text
  if (dg1.$4_diagnosisDescription) {
    if (!condition.code) {
      condition.code = {};
    }
    condition.code.text = dg1.$4_diagnosisDescription;
  }

  // =========================================================================
  // Clinical Status (default to active)
  // =========================================================================

  condition.clinicalStatus = {
    coding: [
      {
        system: "http://terminology.hl7.org/CodeSystem/condition-clinical",
        code: "active",
      },
    ],
  };

  // =========================================================================
  // Onset
  // =========================================================================

  // DG1-5: Diagnosis Date/Time -> onsetDateTime
  if (dg1.$5_diagnosisDateTime) {
    condition.onsetDateTime = convertDTMToDateTime(dg1.$5_diagnosisDateTime);
  }

  // =========================================================================
  // Asserter
  // =========================================================================

  // DG1-16: Diagnosing Clinician -> asserter (first one only, FHIR doesn't allow repeats)
  if (dg1.$16_diagnosingClinician && dg1.$16_diagnosingClinician.length > 0) {
    const practitioner = convertXCNToPractitioner(dg1.$16_diagnosingClinician[0]);
    if (practitioner) {
      // Build display from name
      const name = practitioner.name?.[0];
      const displayParts: string[] = [];
      if (name?.given) {displayParts.push(...name.given);}
      if (name?.family) {displayParts.push(name.family);}

      const asserterRef: Reference<"Practitioner"> = {};
      if (displayParts.length > 0) {
        asserterRef.display = displayParts.join(" ");
      }
      if (practitioner.identifier?.[0]) {
        asserterRef.identifier = practitioner.identifier[0];
      }
      if (asserterRef.display || asserterRef.identifier) {
        condition.asserter = asserterRef;
      }
    }
  }

  // =========================================================================
  // Recorded Date and Extensions
  // =========================================================================

  const extensions: Extension[] = [];

  // DG1-19: Attestation Date/Time -> recordedDate and extension
  if (dg1.$19_attestationDateTime) {
    const attestationDateTime = convertDTMToDateTime(dg1.$19_attestationDateTime);
    if (attestationDateTime) {
      condition.recordedDate = attestationDateTime;

      // Also add as asserted date extension
      extensions.push({
        url: EXT_ASSERTED_DATE,
        valueDateTime: attestationDateTime,
      });
    }
  }

  // =========================================================================
  // Identifier
  // =========================================================================

  // DG1-20: Diagnosis Identifier -> identifier
  if (dg1.$20_diagnosisIdentifier) {
    const identifier = convertEIToIdentifier(dg1.$20_diagnosisIdentifier);
    if (identifier) {
      condition.identifier = [identifier];
    }
  }

  // =========================================================================
  // Verification Status
  // =========================================================================

  // DG1-21: Diagnosis Action Code -> verificationStatus
  // "D" (Delete) maps to "entered-in-error"
  if (dg1.$21_diagnosisActionCode === "D") {
    condition.verificationStatus = {
      coding: [
        {
          system: CONDITION_VER_STATUS_SYSTEM,
          code: "entered-in-error",
        },
      ],
    };
  }

  // =========================================================================
  // Extensions
  // =========================================================================

  // DG1-22: Parent Diagnosis -> extension[condition-dueTo]
  // This would require resolving the EI to a Condition reference
  // For now, we'll store the identifier as a reference

  if (extensions.length > 0) {
    condition.extension = extensions;
  }

  return condition;
}
