/**
 * HL7v2 ORC Segment to FHIR ServiceRequest Mapping
 * Based on: HL7 Segment - FHIR R4_ ORC[ServiceRequest] - ORC.csv
 *
 * Builds a partial ServiceRequest from ORC fields. The caller merges
 * OBR or RXO fields on top and sets subject/encounter references.
 */

import type { ORC, XCN } from "@healthsamurai/interbox/hl7v2";
import type {
  ServiceRequest,
  Identifier,
  Reference,
} from "@healthsamurai/interbox/fhir/4.0.1";
import {
  convertEIToTypedIdentifier,
  convertEIToIdentifierExtension,
} from "../datatypes/ei-coding.ts";
import { convertCWEToCodeableConcept } from "../datatypes/cwe-codeableconcept.ts";
import { convertXCNToPractitioner } from "../datatypes/xcn-practitioner.ts";
import { convertDTMToDateTime } from "../datatypes/dtm-datetime.ts";

// ============================================================================
// ORC-5 Order Status -> FHIR request-status (HL7 Table 0038)
// ============================================================================

const ORDER_STATUS_MAP: Record<string, ServiceRequest["status"]> = {
  CA: "revoked",
  CM: "completed",
  DC: "revoked",
  ER: "entered-in-error",
  HD: "on-hold",
  IP: "active",
  RP: "revoked",
  SC: "active",
};

// ============================================================================
// ORC-1 Order Control Code -> FHIR request-status (HL7 Table 0119)
// ============================================================================

const ORDER_CONTROL_STATUS_MAP: Record<string, ServiceRequest["status"]> = {
  NW: "active",
  CA: "active",
  OC: "revoked",
  DC: "revoked",
  HD: "active",
  OH: "on-hold",
  HR: "on-hold",
  CR: "revoked",
  DR: "revoked",
};

// ============================================================================
// Status Resolution
// ============================================================================

/**
 * Resolve ORC-based order status to FHIR request-status.
 *
 * Resolution tiers:
 * 1. ORC-5 valued + in ORDER_STATUS_MAP (Table 0038) -> use it
 * 2. ORC-5 valued + NOT in standard map -> "unknown" (no error kind for
 *    ORC-5 in the canonical taxonomy)
 * 3. ORC-5 empty -> use ORDER_CONTROL_STATUS_MAP from ORC-1 (Table 0119)
 * 4. Neither yields a mapping -> "unknown"
 */
export function resolveOrderStatus(orc: ORC): ServiceRequest["status"] {
  const orderStatus = orc.$5_orderStatus?.toString().trim() || undefined;

  if (orderStatus) {
    const standardMapping = ORDER_STATUS_MAP[orderStatus.toUpperCase()];
    if (standardMapping) {
      return standardMapping;
    }
    return "unknown";
  }

  // ORC-5 empty -> fall back to ORC-1
  const orderControl = orc.$1_orderControl?.toString().trim() || undefined;
  if (orderControl) {
    const controlMapping = ORDER_CONTROL_STATUS_MAP[orderControl.toUpperCase()];
    if (controlMapping) {
      return controlMapping;
    }
  }

  return "unknown";
}

// ============================================================================
// Requester Reference Builder
// ============================================================================

/**
 * Build a display-only Reference<Practitioner> from the first XCN in the array.
 * Uses inline display reference for consistency with existing converters.
 */
export function buildRequesterReference(
  xcns: XCN[] | undefined,
): Reference<"Practitioner"> | undefined {
  const xcn = xcns?.[0];
  if (!xcn) {return undefined;}

  const practitioner = convertXCNToPractitioner(xcn);
  if (!practitioner) {return undefined;}

  const name = practitioner.name?.[0];
  const displayParts: string[] = [];
  if (name) {
    if (name.prefix) {displayParts.push(...name.prefix);}
    if (name.given) {displayParts.push(...name.given);}
    if (name.family) {displayParts.push(name.family);}
    if (name.suffix) {displayParts.push(...name.suffix);}
  }

  const ref: Reference<"Practitioner"> = {};

  if (practitioner.identifier?.[0]) {
    ref.identifier = practitioner.identifier[0];
  }

  if (displayParts.length > 0) {
    ref.display = displayParts.join(" ");
  }

  // Need at least identifier or display to be useful
  if (!ref.identifier && !ref.display) {return undefined;}

  return ref;
}

// ============================================================================
// Main Converter Function
// ============================================================================

/**
 * Build partial ServiceRequest from ORC segment.
 *
 * Returns base ServiceRequest with status, intent, identifiers, requester, etc.
 * Caller merges OBR fields on top and sets subject/encounter references.
 *
 * Field Mappings:
 * - ORC-1 -> status (fallback when ORC-5 empty), authoredOn condition
 * - ORC-2 -> identifier[PLAC]
 * - ORC-3 -> identifier[FILL]
 * - ORC-4 -> requisition (EI -> Identifier)
 * - ORC-5 -> status (primary source)
 * - ORC-9 -> authoredOn (only when ORC-1 = "NW")
 * - ORC-12 -> requester (display reference)
 * - ORC-29 -> locationCode (CWE -> CodeableConcept)
 */
export function convertORCToServiceRequest(orc: ORC): Partial<ServiceRequest> {
  const serviceRequest: Partial<ServiceRequest> = {
    status: resolveOrderStatus(orc),
    intent: "order",
  };

  // ORC-2: Placer Order Number -> identifier[PLAC]
  // ORC-3: Filler Order Number -> identifier[FILL]
  const identifiers: Identifier[] = [];
  const placerIdentifier = convertEIToTypedIdentifier(orc.$2_placerOrderNumber, "PLAC");
  if (placerIdentifier) {identifiers.push(placerIdentifier);}

  const fillerIdentifier = convertEIToTypedIdentifier(orc.$3_fillerOrderNumber, "FILL");
  if (fillerIdentifier) {identifiers.push(fillerIdentifier);}

  if (identifiers.length > 0) {
    serviceRequest.identifier = identifiers;
  }

  // ORC-4: Placer Group Number -> requisition (EI -> Identifier)
  const requisition = convertEIToIdentifierExtension(orc.$4_placerGroupNumber);
  if (requisition) {
    serviceRequest.requisition = requisition;
  }

  // ORC-9: Date/Time of Transaction -> authoredOn (only when ORC-1 = "NW")
  const orderControl = orc.$1_orderControl?.toString().trim().toUpperCase();
  if (orderControl === "NW" && orc.$9_transactionDateTime) {
    serviceRequest.authoredOn = convertDTMToDateTime(orc.$9_transactionDateTime);
  }

  // ORC-12: Ordering Provider -> requester (display reference)
  const requester = buildRequesterReference(orc.$12_orderingProvider);
  if (requester) {
    serviceRequest.requester = requester;
  }

  // ORC-29: Order Type -> locationCode (CWE -> CodeableConcept)
  if (orc.$29_orderType) {
    const locationCode = convertCWEToCodeableConcept(orc.$29_orderType);
    if (locationCode) {
      serviceRequest.locationCode = [locationCode];
    }
  }

  return serviceRequest;
}
