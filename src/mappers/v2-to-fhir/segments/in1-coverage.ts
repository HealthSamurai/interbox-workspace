/**
 * HL7v2 IN1 Segment to FHIR Coverage Mapping
 * Based on: HL7 Segment - FHIR R4_ IN1[Coverage] - Sheet1.csv
 */

import type { IN1, CE, CX, XON } from "@health-samurai/interbox/hl7v2";
import type {
  Coverage,
  Identifier,
  Period,
  Reference,
} from "@health-samurai/interbox/fhir/4.0.1";
import { convertCEToCodeableConcept } from "../datatypes/ce-codeableconcept.ts";
import { convertXONToOrganization } from "../datatypes/xon-organization.ts";
import { toKebabCase } from "../support/string.ts";

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Convert HL7v2 DT to FHIR dateTime
 */
function convertDTToDateTime(dt: string | undefined): string | undefined {
  if (!dt) { return undefined; }
  if (dt.length < 8) { return undefined; }

  const year = dt.substring(0, 4);
  const month = dt.substring(4, 6);
  const day = dt.substring(6, 8);

  return `${year}-${month}-${day}`;
}

/**
 * Convert CWE/CE to Identifier
 */
function convertCEToIdentifier(ce: CE | undefined): Identifier | undefined {
  if (!ce) { return undefined; }

  const identifier: Identifier = {};

  if (ce.$1_code) {
    identifier.value = ce.$1_code;
  }

  if (ce.$3_system) {
    identifier.system = ce.$3_system;
  }

  if (ce.$2_text) {
    identifier.type = {
      text: ce.$2_text,
    };
  }

  if (!identifier.value) { return undefined; }

  return identifier;
}

/**
 * Determine coverage status based on expiration date
 * If coverage has expired, return "cancelled", otherwise "active"
 */
function determineCoverageStatus(
  periodEnd: string | undefined,
): "active" | "cancelled" {
  if (!periodEnd) { return "active"; }

  const now = new Date();
  const endDate = new Date(periodEnd);

  // If end date is in the past, coverage is cancelled
  if (endDate < now) {
    return "cancelled";
  }

  return "active";
}

// ============================================================================
// Main Converter Function
// ============================================================================

/**
 * Convert HL7v2 IN1 segment to FHIR Coverage
 *
 * Field Mappings:
 * - IN1-2  -> identifier (Health Plan ID)
 * - IN1-4  -> payor (Insurance Company Name -> Organization)
 * - IN1-12 -> period.start (Plan Effective Date)
 * - IN1-13 -> period.end (Plan Expiration Date)
 * - IN1-15 -> type (Plan Type)
 * - IN1-17 -> relationship (Insured's Relationship To Patient)
 * - IN1-36 -> subscriberId (Policy Number)
 */
export function convertIN1ToCoverage(
  in1: IN1,
): Omit<Coverage, "beneficiary" | "payor" | "status"> & {
  beneficiary: { reference?: string };
  payor: { display?: string; identifier?: Identifier }[];
  status: Coverage["status"];
} {
  const coverage: Omit<Coverage, "beneficiary" | "payor" | "status"> & {
    beneficiary: { reference?: string };
    payor: { display?: string; identifier?: Identifier }[];
    status: Coverage["status"];
  } = {
    resourceType: "Coverage",
    status: "active", // Will be updated based on period.end
    beneficiary: {}, // Must be set by caller
    payor: [] as { display?: string; identifier?: Identifier }[], // Will be populated
  };

  // =========================================================================
  // Identifier
  // =========================================================================

  // IN1-2: Health Plan ID -> identifier
  if (in1.$2_insurancePlanId) {
    const identifier = convertCEToIdentifier(in1.$2_insurancePlanId);
    if (identifier) {
      coverage.identifier = [identifier];
    }
  }

  // =========================================================================
  // Payor
  // =========================================================================

  // IN1-4: Insurance Company Name -> payor (as Organization reference)
  if (in1.$4_insuranceCompanyName && in1.$4_insuranceCompanyName.length > 0) {
    const payors: Reference<"Organization">[] = [];

    for (const xon of in1.$4_insuranceCompanyName) {
      const org = convertXONToOrganization(xon);
      if (org) {
        // Create a reference with display
        const payorRef: Reference<"Organization"> = {};

        if (org.name) {
          payorRef.display = org.name;
        }

        if (org.identifier?.[0]) {
          payorRef.identifier = org.identifier[0];
        }

        if (payorRef.display || payorRef.identifier) {
          payors.push(payorRef);
        }
      }
    }

    if (payors.length > 0) {
      coverage.payor = payors;
    }
  }

  // If no payor was set, add a placeholder
  if (coverage.payor.length === 0) {
    coverage.payor = [{ display: "Unknown" }];
  }

  // =========================================================================
  // Period
  // =========================================================================

  // IN1-12: Plan Effective Date -> period.start
  // IN1-13: Plan Expiration Date -> period.end
  const periodStart = convertDTToDateTime(in1.$12_planEffectiveDate);
  const periodEnd = convertDTToDateTime(in1.$13_planExpirationDate);

  if (periodStart || periodEnd) {
    const period: Period = {};
    if (periodStart) { period.start = periodStart; }
    if (periodEnd) { period.end = periodEnd; }
    coverage.period = period;
  }

  // =========================================================================
  // Status (based on expiration date)
  // =========================================================================

  coverage.status = determineCoverageStatus(periodEnd);

  // =========================================================================
  // Type
  // =========================================================================

  // IN1-15: Plan Type -> type
  if (in1.$15_planType) {
    coverage.type = {
      coding: [
        {
          code: in1.$15_planType,
        },
      ],
    };
  }

  // =========================================================================
  // Relationship
  // =========================================================================

  // IN1-17: Insured's Relationship To Patient -> relationship
  if (in1.$17_insuredsRelationshipToPatient) {
    const relationship = convertCEToCodeableConcept(
      in1.$17_insuredsRelationshipToPatient,
    );
    if (relationship) {
      coverage.relationship = relationship;
    }
  }

  // =========================================================================
  // Subscriber ID
  // =========================================================================

  // IN1-36: Policy Number -> subscriberId
  if (in1.$36_policyNumber) {
    coverage.subscriberId = in1.$36_policyNumber;
  }

  // =========================================================================
  // Group Number
  // =========================================================================

  // IN1-8: Group Number -> class with type="group"
  if (in1.$8_groupNumber) {
    coverage.class = [
      {
        type: {
          coding: [
            {
              system: "http://terminology.hl7.org/CodeSystem/coverage-class",
              code: "group",
            },
          ],
        },
        value: in1.$8_groupNumber,
      },
    ];
  }

  return coverage;
}

// ============================================================================
// Coverage ID and Validation Helpers
// ============================================================================

/**
 * Generate composite coverage ID.
 * Format: {patientId}-{payor-identifier}
 * Payor identifier extracted from IN1-3 (Insurance Company ID) or IN1-4 (Insurance Company Name).
 *
 * produces the same Coverage ID regardless of message type.
 */
export function generateCoverageId(in1: IN1, patientId: string | undefined): string {
  const prefix = patientId || "unknown";

  // Try to get payor identifier from IN1-3 (Insurance Company ID)
  let payorId: string | undefined;

  if (in1.$3_insuranceCompanyId && in1.$3_insuranceCompanyId.length > 0) {
    payorId = in1.$3_insuranceCompanyId[0]?.$1_value;
  }

  // Fallback to first payor organization name
  if (!payorId && in1.$4_insuranceCompanyName && in1.$4_insuranceCompanyName.length > 0) {
    const orgName = in1.$4_insuranceCompanyName[0]?.$1_name;
    if (orgName) {
      payorId = toKebabCase(orgName);
    }
  }

  if (!payorId) {
    payorId = "coverage";
  }

  return `${prefix}-${toKebabCase(payorId)}`;
}

/**
 * Check if IN1 segment has valid payor information.
 * Returns true if IN1 has either Insurance Company Name (IN1-4) or Insurance Company ID (IN1-3).
 */
export function hasValidPayorInfo(in1: IN1): boolean {
  if (in1.$4_insuranceCompanyName && in1.$4_insuranceCompanyName.length > 0) {
    const hasName = in1.$4_insuranceCompanyName.some((xon: XON) => xon.$1_name);
    if (hasName) { return true; }
  }

  if (in1.$3_insuranceCompanyId && in1.$3_insuranceCompanyId.length > 0) {
    const hasId = in1.$3_insuranceCompanyId.some((cx: CX) => cx.$1_value);
    if (hasId) { return true; }
  }

  return false;
}
