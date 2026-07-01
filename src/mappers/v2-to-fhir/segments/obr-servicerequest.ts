/**
 * HL7v2 OBR Segment to FHIR ServiceRequest Merger
 * Based on: HL7 Segment - FHIR R4_ OBR[ServiceRequest] - OBR.csv
 *
 * Merges OBR fields into a ServiceRequest already built from ORC.
 * Separate from obr-diagnosticreport.ts which produces DiagnosticReport for ORU.
 */

import type { OBR, ORC } from "@healthsamurai/interbox/hl7v2";
import type { ServiceRequest } from "@healthsamurai/interbox/fhir/4.0.1";
import { convertCEToCodeableConcept } from "../datatypes/ce-codeableconcept.ts";
import { convertDTMToDateTime } from "../datatypes/dtm-datetime.ts";
import { convertEIToTypedIdentifier } from "../datatypes/ei-coding.ts";
import { buildRequesterReference } from "./orc-servicerequest.ts";

// ============================================================================
// OBR-5 Priority -> FHIR ServiceRequest.priority
// ============================================================================

const PRIORITY_MAP: Record<string, ServiceRequest["priority"]> = {
  S: "stat",
  A: "stat",
  R: "routine",
  T: "urgent",
};

// ============================================================================
// Main Merger Function
// ============================================================================

/**
 * Merge OBR fields into an existing ServiceRequest (built from ORC).
 *
 * OBR provides: code (OBR-4), identifiers (OBR-2/3 fallback), priority (OBR-5),
 * occurrenceDateTime (OBR-6), intent override (OBR-11), requester fallback (OBR-16),
 * reasonCode (OBR-31).
 *
 * Identifier and requester fields from OBR are only used when the corresponding
 * ORC fields were not valued (checked via the existing serviceRequest fields).
 */
export function mergeOBRIntoServiceRequest(obr: OBR, serviceRequest: ServiceRequest, orc: ORC): void {
  // OBR-4: Universal Service ID -> code (always mapped)
  const code = convertCEToCodeableConcept(obr.$4_service);
  if (code) {
    serviceRequest.code = code;
  }

  // OBR-2: Placer Order Number -> identifier[PLAC] (only if ORC-2 not valued)
  if (!orc.$2_placerOrderNumber?.$1_value) {
    const placerIdentifier = convertEIToTypedIdentifier(obr.$2_placerOrderNumber, "PLAC");
    if (placerIdentifier) {
      serviceRequest.identifier = [...(serviceRequest.identifier || []), placerIdentifier];
    }
  }

  // OBR-3: Filler Order Number -> identifier[FILL] (only if ORC-3 not valued)
  if (!orc.$3_fillerOrderNumber?.$1_value) {
    const fillerIdentifier = convertEIToTypedIdentifier(obr.$3_fillerOrderNumber, "FILL");
    if (fillerIdentifier) {
      serviceRequest.identifier = [...(serviceRequest.identifier || []), fillerIdentifier];
    }
  }

  // OBR-5: Priority -> priority
  if (obr.$5_priorityObr) {
    const priority = PRIORITY_MAP[obr.$5_priorityObr.toUpperCase()];
    if (priority) {
      serviceRequest.priority = priority;
    }
  }

  // OBR-6: Requested Date/Time -> occurrenceDateTime
  const occurrenceDateTime = convertDTMToDateTime(obr.$6_requestedDateTime);
  if (occurrenceDateTime) {
    serviceRequest.occurrenceDateTime = occurrenceDateTime;
  }

  // OBR-11: Specimen Action Code -> intent override
  // "G" -> "reflex-order"; all other values keep existing intent
  if (obr.$11_specimenActionCode) {
    const actionCode = obr.$11_specimenActionCode.toString().toUpperCase();
    if (actionCode === "G") {
      serviceRequest.intent = "reflex-order";
    }
  }

  // OBR-16: Ordering Provider -> requester (only if ORC-12 not valued)
  if (!orc.$12_orderingProvider?.length) {
    const requester = buildRequesterReference(obr.$16_orderingProvider);
    if (requester) {
      serviceRequest.requester = requester;
    }
  }

  // OBR-31: Reason for Study -> reasonCode
  if (obr.$31_reasonForStudy) {
    const reasonCodes = obr.$31_reasonForStudy
      .map((ce) => convertCEToCodeableConcept(ce))
      .filter((cc): cc is NonNullable<typeof cc> => cc !== undefined);
    if (reasonCodes.length > 0) {
      serviceRequest.reasonCode = reasonCodes;
    }
  }
}
