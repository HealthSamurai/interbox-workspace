/**
 * HL7v2 AL1 Segment to FHIR AllergyIntolerance Mapping
 * Based on: HL7 Segment - FHIR R4_ AL1[AllergyIntolerance] - AL1.csv
 */

import type { AL1 } from "@healthsamurai/interbox/hl7v2";
import type {
  AllergyIntolerance,
  AllergyIntoleranceReaction,
} from "@healthsamurai/interbox/fhir/4.0.1";
import { convertCEToCodeableConcept } from "../datatypes/ce-codeableconcept.ts";

// ============================================================================
// Code Systems
// ============================================================================

const CLINICAL_STATUS_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical";

// ============================================================================
// Category Mapping (HL7 Table 0127 -> FHIR AllergyIntoleranceCategory)
// ============================================================================

const CATEGORY_MAP: Record<string, AllergyIntolerance["category"]> = {
  DA: ["medication"], // Drug allergy
  FA: ["food"],       // Food allergy
  MA: ["medication"], // Miscellaneous allergy
  MC: ["medication"], // Miscellaneous contraindication
  EA: ["environment"], // Environmental allergy
  AA: ["biologic"],    // Animal allergy
  PA: ["environment"], // Plant allergy
  LA: ["environment"], // Pollen allergy
};

// ============================================================================
// Type Mapping (HL7 Table 0127 -> FHIR AllergyIntoleranceType)
// ============================================================================

const TYPE_MAP: Record<string, AllergyIntolerance["type"]> = {
  DA: "allergy",
  FA: "allergy",
  MA: "allergy",
  MC: "intolerance",
  EA: "allergy",
  AA: "allergy",
  PA: "allergy",
  LA: "allergy",
};

// ============================================================================
// Criticality Mapping (HL7 Table 0128 -> FHIR AllergyIntoleranceCriticality)
// ============================================================================

const CRITICALITY_MAP: Record<string, AllergyIntolerance["criticality"]> = {
  SV: "high",        // Severe
  MO: "low",         // Moderate
  MI: "low",         // Mild
  U: "unable-to-assess", // Unknown
};

// ============================================================================
// Reaction Severity Mapping (HL7 Table 0128 -> FHIR AllergyIntoleranceReaction.severity)
// ============================================================================

const SEVERITY_MAP: Record<string, AllergyIntoleranceReaction["severity"]> = {
  SV: "severe",
  MO: "moderate",
  MI: "mild",
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Convert HL7v2 DT to FHIR dateTime
 */
function convertDTToDateTime(dt: string | undefined): string | undefined {
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
 * Convert HL7v2 AL1 segment to FHIR AllergyIntolerance
 *
 * Field Mappings:
 * - AL1-2  -> category, type (Allergen Type Code)
 * - AL1-3  -> code (Allergen Code/Mnemonic/Description)
 * - AL1-4  -> criticality, reaction.severity (Allergy Severity Code)
 * - AL1-5  -> reaction.manifestation.text (Allergy Reaction Code)
 * - AL1-6  -> onsetDateTime (Identification Date)
 *
 * Default Values:
 * - clinicalStatus = "active" (per FHIR constraint ait-1)
 */
export function convertAL1ToAllergyIntolerance(al1: AL1): Omit<AllergyIntolerance, "patient"> & { patient: { reference?: string } } {
  const allergyIntolerance: Omit<AllergyIntolerance, "patient"> & { patient: { reference?: string } } = {
    resourceType: "AllergyIntolerance",
    patient: {}, // Must be set by caller
    // Set default clinical status to "active" per FHIR constraint
    clinicalStatus: {
      coding: [
        {
          system: CLINICAL_STATUS_SYSTEM,
          code: "active",
        },
      ],
    },
  };

  // =========================================================================
  // Code (required)
  // =========================================================================

  // AL1-3: Allergen Code/Mnemonic/Description -> code
  if (al1.$3_allergenCodeMnemonicDescription) {
    const code = convertCEToCodeableConcept(
      al1.$3_allergenCodeMnemonicDescription
    );
    if (code) {
      allergyIntolerance.code = code;
    }
  }

  // =========================================================================
  // Category and Type
  // =========================================================================

  // AL1-2: Allergen Type Code -> category and type
  if (al1.$2_allergenTypeCode) {
    const typeCode = al1.$2_allergenTypeCode.$1_code?.toUpperCase();

    if (typeCode) {
      // Map to category
      const category = CATEGORY_MAP[typeCode];
      if (category) {
        allergyIntolerance.category = category;
      }

      // Map to type
      const allergyType = TYPE_MAP[typeCode];
      if (allergyType) {
        allergyIntolerance.type = allergyType;
      }
    }
  }

  // =========================================================================
  // Criticality and Reaction Severity
  // =========================================================================

  // AL1-4: Allergy Severity Code -> criticality
  if (al1.$4_allergySeverityCode) {
    const severityCode = al1.$4_allergySeverityCode.$1_code?.toUpperCase();

    if (severityCode) {
      // Map to criticality
      const criticality = CRITICALITY_MAP[severityCode];
      if (criticality) {
        allergyIntolerance.criticality = criticality;
      }
    }
  }

  // =========================================================================
  // Reaction
  // =========================================================================

  // AL1-5: Allergy Reaction Code -> reaction.manifestation.text
  if (al1.$5_allergyReactionCode && al1.$5_allergyReactionCode.length > 0) {
    const reactions: AllergyIntoleranceReaction[] = [];

    for (const reactionText of al1.$5_allergyReactionCode) {
      if (reactionText) {
        const reaction: AllergyIntoleranceReaction = {
          manifestation: [
            {
              text: reactionText,
            },
          ],
        };

        // Add severity if available from AL1-4
        if (al1.$4_allergySeverityCode) {
          const severityCode = al1.$4_allergySeverityCode.$1_code?.toUpperCase();
          if (severityCode) {
            const severity = SEVERITY_MAP[severityCode];
            if (severity) {
              reaction.severity = severity;
            }
          }
        }

        reactions.push(reaction);
      }
    }

    if (reactions.length > 0) {
      allergyIntolerance.reaction = reactions;
    }
  }

  // =========================================================================
  // Onset
  // =========================================================================

  // AL1-6: Identification Date -> onsetDateTime
  if (al1.$6_identificationDate) {
    allergyIntolerance.onsetDateTime = convertDTToDateTime(
      al1.$6_identificationDate
    );
  }

  return allergyIntolerance;
}
