/**
 * HL7v2 OBR Segment to FHIR DiagnosticReport Mapping
 * Based on: HL7 v2.5.1 OBR segment specification
 */

import type { OBR } from "@healthsamurai/interbox/hl7v2";
import type { DiagnosticReport } from "@healthsamurai/interbox/fhir/4.0.1";
import { convertCEToCodeableConcept } from "../datatypes/ce-codeableconcept.ts";
import { convertDTMToDateTime } from "../support/datetime.ts";
import { sanitizeForId } from "../support/string.ts";

// ============================================================================
// Status Mapping
// ============================================================================

/**
 * OBR-25 Result Status to FHIR DiagnosticReport.status mapping
 *
 * HL7 v2 Table 0123 (Result Status):
 * - O = Order received; specimen not yet received
 * - I = No results available; specimen received, procedure incomplete
 * - S = No results available; procedure scheduled
 * - P = Preliminary
 * - A = Some results available (partial)
 * - R = Results stored; not yet verified
 * - N = Results not finalized
 * - C = Correction to results (corrected)
 * - M = Modified results
 * - F = Final results
 * - X = No results available; order cancelled
 */
const OBR25_STATUS_MAP: Record<string, DiagnosticReport["status"]> = {
  O: "registered",
  I: "registered",
  S: "registered",
  P: "preliminary",
  A: "partial",
  R: "partial",
  N: "partial",
  C: "corrected",
  M: "corrected",
  F: "final",
  X: "cancelled",
};

/**
 * Map OBR-25 Result Status to FHIR DiagnosticReport.status.
 * DiagnosticReport.status is mandatory in FHIR, so an empty or unmapped
 * OBR-25 falls back to "unknown" (there is no error kind for OBR-25 in the
 * canonical taxonomy).
 */
export function mapObrStatus(
  status: string | undefined,
): DiagnosticReport["status"] {
  const normalized = status?.trim();
  if (!normalized) {return "unknown";}
  return OBR25_STATUS_MAP[normalized.toUpperCase()] ?? "unknown";
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Convert HL7v2 DTM to FHIR instant (for issued field)
 */
function convertDTMToInstant(dtm: string | undefined): string | undefined {
  if (!dtm) {return undefined;}

  const year = dtm.substring(0, 4);
  const month = dtm.substring(4, 6) || "01";
  const day = dtm.substring(6, 8) || "01";
  const hour = dtm.substring(8, 10) || "00";
  const minute = dtm.substring(10, 12) || "00";
  const second = dtm.substring(12, 14) || "00";

  return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
}

// ============================================================================
// Main Converter Function
// ============================================================================

/**
 * Convert OBR segment to FHIR DiagnosticReport.
 *
 * Field mappings:
 * - orderNumber (OBR-3.1 ?? OBR-2.1, resolved by the caller) → id (deterministic)
 * - OBR-4 (Universal Service ID) → code
 * - OBR-7 (Observation Date/Time) → effectiveDateTime
 * - OBR-22 (Results Report/Status Change) → issued
 * - OBR-25 (Result Status) → status (empty/unmapped → "unknown")
 */
export function convertOBRToDiagnosticReport(
  obr: OBR,
  orderNumber: string,
): DiagnosticReport {
  const diagnosticReport: DiagnosticReport = {
    resourceType: "DiagnosticReport",
    id: sanitizeForId(orderNumber),
    status: mapObrStatus(obr.$25_resultStatus),
    code: convertCEToCodeableConcept(obr.$4_service) || {
      text: "Unknown",
    },
  };

  // OBR-7: Observation Date/Time → effectiveDateTime
  if (obr.$7_observationDateTime) {
    diagnosticReport.effectiveDateTime = convertDTMToDateTime(
      obr.$7_observationDateTime,
    );
  }

  // OBR-22: Results Report/Status Change → issued
  if (obr.$22_resultsRptStatusChngDateTime) {
    diagnosticReport.issued = convertDTMToInstant(
      obr.$22_resultsRptStatusChngDateTime,
    );
  }

  return diagnosticReport;
}
