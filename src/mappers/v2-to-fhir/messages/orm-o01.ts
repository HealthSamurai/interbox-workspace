/**
 * HL7v2 ORM_O01 Message to FHIR Converter
 *
 * ORM_O01 - General Order Message
 *
 * Creates:
 * - Patient from PID
 * - ServiceRequest from ORC + OBR (diagnostic/lab/radiology orders)
 * - MedicationRequest from ORC + RXO (pharmacy/medication orders)
 * - Observation from OBX (supporting observations, raw OBX-3 code)
 *
 * Supports multiple ORDER groups per message with independent order types.
 *
 * Encounter handling: ADT is the source of truth for Encounters, so ORM does
 * not emit one. When PV1-19 is present the deterministic Encounter id is
 * computed and order resources reference it; a PV1 without a visit number
 * (common class-only PV1 in ORM) is treated as absent.
 */

import type {
  HL7v2Message,
  HL7v2Segment,
} from "@health-samurai/interbox/hl7v2";
import {
  fromMSH,
  fromNTE,
  fromOBR,
  fromORC,
  fromPID,
  fromPV1,
  fromRXO,
  type EI,
  type ORC,
} from "@health-samurai/interbox/hl7v2";
import type {
  Annotation,
  DomainResource,
  MedicationRequest,
  Observation,
  Reference,
  ServiceRequest,
} from "@health-samurai/interbox/fhir/4.0.1";
import { domainError } from "@health-samurai/interbox";
import { findSegment, requirePid } from "../support/segments.ts";
import { senderFromMsh } from "../support/msh.ts";
import { patientIdFromPid, encounterIdFromPv1 } from "../support/identity.ts";
import { sanitizeForId } from "../support/string.ts";
import { fromOBX } from "../wrappers/obx.ts";
import { convertPIDToPatient } from "../segments/pid-patient.ts";
import { convertOBXToObservation } from "../segments/obx-observation.ts";
import {
  convertORCToServiceRequest,
  resolveOrderStatus,
} from "../segments/orc-servicerequest.ts";
import { mergeOBRIntoServiceRequest } from "../segments/obr-servicerequest.ts";
import { convertRXOToMedicationRequest } from "../segments/rxo-medicationrequest.ts";
import { convertNTEsToAnnotation } from "../segments/nte-annotation.ts";

// ============================================================================
// Order Grouping Types
// ============================================================================

interface ORMOrderGroup {
  orc: HL7v2Segment;
  orderChoice?: HL7v2Segment;
  orderChoiceType: "OBR" | "RXO" | "unknown";
  ntes: HL7v2Segment[];
  observations: Array<{ obx: HL7v2Segment; ntes: HL7v2Segment[] }>;
}

// ============================================================================
// Order Grouping
// ============================================================================

/**
 * Group ORM message segments by ORC boundaries.
 *
 * Each ORC starts a new ORDER group. Segments between ORCs belong to
 * the current group. The ORDER_CHOICE type is detected by scanning for
 * the first OBR or RXO segment within the group.
 *
 * NTE placement: NTEs after an OBX attach to that observation;
 * NTEs after OBR/RXO (before any OBX) attach as order-level notes.
 *
 * Only processes segments after the first ORC (PID, PV1 etc.
 * are handled separately by the main converter).
 */
export function groupORMOrders(message: HL7v2Message): ORMOrderGroup[] {
  const groups: ORMOrderGroup[] = [];
  let currentGroup: ORMOrderGroup | null = null;
  let currentObservation: { obx: HL7v2Segment; ntes: HL7v2Segment[] } | null = null;
  let firstOrcSeen = false;

  for (const segment of message) {
    switch (segment.segment) {
      case "ORC": {
        // Flush pending observation from previous group
        if (currentObservation && currentGroup) {
          currentGroup.observations.push(currentObservation);
          currentObservation = null;
        }

        firstOrcSeen = true;
        currentGroup = {
          orc: segment,
          orderChoiceType: "unknown",
          ntes: [],
          observations: [],
        };
        groups.push(currentGroup);
        break;
      }

      case "OBR": {
        if (!firstOrcSeen || !currentGroup) {break;}
        if (!currentGroup.orderChoice) {
          currentGroup.orderChoice = segment;
          currentGroup.orderChoiceType = "OBR";
        }
        break;
      }

      case "RXO": {
        if (!firstOrcSeen || !currentGroup) {break;}
        if (!currentGroup.orderChoice) {
          currentGroup.orderChoice = segment;
          currentGroup.orderChoiceType = "RXO";
        }
        break;
      }

      case "NTE": {
        if (!firstOrcSeen || !currentGroup) {break;}
        if (currentObservation) {
          // NTE after OBX -> observation-level note
          currentObservation.ntes.push(segment);
        } else {
          // NTE before any OBX -> order-level note
          currentGroup.ntes.push(segment);
        }
        break;
      }

      case "OBX": {
        if (!firstOrcSeen || !currentGroup) {break;}
        // Flush previous observation
        if (currentObservation) {
          currentGroup.observations.push(currentObservation);
        }
        currentObservation = { obx: segment, ntes: [] };
        break;
      }
    }
  }

  // Flush last pending observation
  if (currentObservation && currentGroup) {
    currentGroup.observations.push(currentObservation);
  }

  return groups;
}

// ============================================================================
// Order Number Resolution
// ============================================================================

/**
 * Resolve the deterministic order number for an ORDER group.
 *
 * Priority:
 * 1. ORC-2 (Placer Order Number) - EI.1, optionally suffixed with -EI.2 when namespace present
 * 2. OBR-2 (Placer Order Number) fallback - only for OBR-based orders, same format
 * 3. Throw field/missing_order_number if neither provides a usable identifier
 *
 * @param orc - Parsed ORC segment
 * @param obrPlacerOrderNumber - OBR-2 Placer Order Number (only for OBR-based orders)
 */
export function resolveOrderNumber(
  orc: ORC,
  obrPlacerOrderNumber?: EI,
): string {
  const orcId = buildIdFromEI(orc.$2_placerOrderNumber);
  if (orcId) {
    return orcId;
  }

  if (obrPlacerOrderNumber) {
    const obrId = buildIdFromEI(obrPlacerOrderNumber);
    if (obrId) {
      return obrId;
    }
  }

  throw domainError(
    "field",
    "missing_order_number",
    "No usable order number: ORC-2.1 empty and OBR-2.1 empty (or not applicable)",
  );
}

/**
 * Build a sanitized ID string from an EI (Entity Identifier) field.
 *
 * Uses EI.1 as the base. If EI.2 (namespace) is present and different
 * from EI.1, appends it as a suffix: `{EI.1}-{EI.2}`.
 */
function buildIdFromEI(ei: EI | undefined): string | undefined {
  const value = ei?.$1_value?.trim();
  if (!value) {return undefined;}

  const namespace = ei?.$2_namespace?.trim();
  const namespaceDiffers = namespace && namespace !== value;

  const raw = namespaceDiffers ? `${value}-${namespace}` : value;
  return sanitizeForId(raw);
}

// ============================================================================
// NTE -> Annotation Processing
// ============================================================================

function processOrderNTEs(nteSegments: HL7v2Segment[]): Annotation[] {
  if (nteSegments.length === 0) {return [];}

  const parsedNtes = nteSegments.map((seg) => fromNTE(seg));
  const annotation = convertNTEsToAnnotation(parsedNtes);
  return annotation ? [annotation] : [];
}

// ============================================================================
// OBX -> Observation Processing (ORM context)
// ============================================================================

/**
 * Process OBX segments in ORM context.
 *
 * ORM OBX segments are supporting observations (ask-at-order-entry questions,
 * clinical context), NOT lab results. Missing OBX-11 defaults to "registered"
 * (handled inside convertOBXToObservation).
 */
function processORMObservations(
  observationGroups: ORMOrderGroup["observations"],
  orderNumber: string,
  patientRef: Reference<"Patient">,
  encounterRef: Reference<"Encounter"> | null,
): Observation[] {
  const observations: Observation[] = [];

  for (const [i, group] of observationGroups.entries()) {
    const obx = fromOBX(group.obx);

    const observation = convertOBXToObservation(obx, orderNumber);
    // Override with positional ID: {orderNumber}-obx-{1-based index}
    observation.id = `${orderNumber}-obx-${i + 1}`.replace(/[^a-z0-9-]/g, "-");

    // Add observation-level NTEs
    if (group.ntes.length > 0) {
      const ntes = group.ntes.map((seg) => fromNTE(seg));
      const annotation = convertNTEsToAnnotation(ntes);
      if (annotation) {
        observation.note = [annotation];
      }
    }

    observation.subject = patientRef;
    if (encounterRef) {
      observation.encounter = encounterRef;
    }

    observations.push(observation);
  }

  return observations;
}

// ============================================================================
// OBR-Based Order Group Processing
// ============================================================================

function processOBROrderGroup(
  group: ORMOrderGroup,
  patientRef: Reference<"Patient">,
  encounterRef: Reference<"Encounter"> | null,
): DomainResource[] {
  const orc = fromORC(group.orc);
  if (!group.orderChoice) {
    // Callers gate this function on orderChoiceType === "OBR" && orderChoice truthy.
    return [];
  }
  const obr = fromOBR(group.orderChoice);

  // Resolve order number (ORC-2, fallback to OBR-2)
  const orderNumber = resolveOrderNumber(orc, obr.$2_placerOrderNumber);

  // Build ServiceRequest from ORC
  const serviceRequest = convertORCToServiceRequest(orc) as ServiceRequest;
  serviceRequest.resourceType = "ServiceRequest";

  // Merge OBR fields
  mergeOBRIntoServiceRequest(obr, serviceRequest, orc);

  // Set ID, subject, encounter
  serviceRequest.id = orderNumber;
  serviceRequest.subject = patientRef;
  if (encounterRef) {
    serviceRequest.encounter = encounterRef;
  }

  // Process NTEs -> ServiceRequest.note
  const notes = processOrderNTEs(group.ntes);
  if (notes.length > 0) {
    serviceRequest.note = notes;
  }

  // Process OBX -> Observations (supporting info)
  const observations = processORMObservations(
    group.observations, orderNumber, patientRef, encounterRef,
  );

  // Link Observations to ServiceRequest.supportingInfo
  if (observations.length > 0) {
    serviceRequest.supportingInfo = observations.map(
      (o) => ({ reference: `Observation/${o.id}` }) as Reference<string>,
    );
  }

  return [serviceRequest, ...observations];
}

// ============================================================================
// RXO-Based Order Group Processing
// ============================================================================

function processRXOOrderGroup(
  group: ORMOrderGroup,
  patientRef: Reference<"Patient">,
  encounterRef: Reference<"Encounter"> | null,
): DomainResource[] {
  const orc = fromORC(group.orc);

  // Resolve order number (ORC-2 only for RXO, no OBR fallback)
  const orderNumber = resolveOrderNumber(orc);

  // Resolve ORC status (same logic as OBR orders)
  const status = resolveOrderStatus(orc);

  // Build MedicationRequest from RXO.
  // convertRXOToMedicationRequest adapts shared ORC status values where needed
  // (for example "revoked" -> "cancelled" for MedicationRequest).
  if (!group.orderChoice) {
    // Callers gate this function on orderChoiceType === "RXO" && orderChoice truthy.
    return [];
  }
  const rxo = fromRXO(group.orderChoice);
  const medicationRequest = convertRXOToMedicationRequest(rxo, status) as MedicationRequest;

  // Set ID, subject, encounter
  medicationRequest.id = orderNumber;
  medicationRequest.subject = patientRef;
  if (encounterRef) {
    medicationRequest.encounter = encounterRef;
  }

  // Process NTEs -> MedicationRequest.note
  const notes = processOrderNTEs(group.ntes);
  if (notes.length > 0) {
    medicationRequest.note = notes;
  }

  // Process OBX -> Observations (supporting info)
  const observations = processORMObservations(
    group.observations, orderNumber, patientRef, encounterRef,
  );

  // Link Observations to MedicationRequest.supportingInformation
  if (observations.length > 0) {
    medicationRequest.supportingInformation = observations.map(
      (o) => ({ reference: `Observation/${o.id}` }) as Reference<string>,
    );
  }

  return [medicationRequest, ...observations];
}

// ============================================================================
// Main Converter
// ============================================================================

/**
 * Convert HL7v2 ORM_O01 message to a flat array of FHIR resources.
 *
 * Message Structure (v2.5):
 * MSH [1..1]
 * PATIENT [0..1]
 *   PID [1..1]
 *   PV1 [0..1]  (via PATIENT_VISIT)
 * ORDER [1..*]
 *   ORC [1..1]
 *   ORDER_DETAIL [0..1]
 *     OBR | RXO (ORDER_CHOICE)
 *     NTE [0..*]
 *     OBSERVATION [0..*]
 *       OBX [1..1]
 *       NTE [0..*]
 *
 * PID required; PV1 optional (class-only PV1 without visit number treated
 * as absent). ORDER groups without an OBR/RXO detail are skipped; if no
 * group is processable the message fails with structure/missing_orc.
 */
export function convertORM_O01(parsed: HL7v2Segment[]): DomainResource[] {
  const mshSegment = findSegment(parsed, "MSH");
  if (!mshSegment) {
    throw domainError(
      "field",
      "missing_sender",
      "MSH segment not found — sending application/facility unavailable",
    );
  }
  const sender = senderFromMsh(fromMSH(mshSegment));

  // Parse PID (required)
  const pid = fromPID(requirePid(parsed));
  const patient = convertPIDToPatient(pid);
  patient.id = patientIdFromPid(pid);
  const patientRef: Reference<"Patient"> = {
    reference: `Patient/${patient.id}`,
  };

  // PV1 is optional for ORM; a PV1 without PV1-19 is treated as absent
  let encounterRef: Reference<"Encounter"> | null = null;
  const pv1Segment = findSegment(parsed, "PV1");
  if (pv1Segment) {
    const encounterId = encounterIdFromPv1(
      fromPV1(pv1Segment),
      sender.sendingFacility,
    );
    if (encounterId) {
      encounterRef = { reference: `Encounter/${encounterId}` };
    }
  }

  // Group ORDER segments
  const orderGroups = groupORMOrders(parsed);

  // Process each ORDER group
  const entries: DomainResource[] = [patient];
  let processableGroupCount = 0;

  for (const group of orderGroups) {
    if (group.orderChoiceType === "OBR" && group.orderChoice) {
      const groupEntries = processOBROrderGroup(group, patientRef, encounterRef);
      entries.push(...groupEntries);
      if (groupEntries.length > 0) {processableGroupCount++;}
    } else if (group.orderChoiceType === "RXO" && group.orderChoice) {
      const groupEntries = processRXOOrderGroup(group, patientRef, encounterRef);
      entries.push(...groupEntries);
      if (groupEntries.length > 0) {processableGroupCount++;}
    }
    // ORC without ORDER_DETAIL -- skip this group
  }

  if (processableGroupCount === 0) {
    throw domainError(
      "structure",
      "missing_orc",
      orderGroups.length === 0
        ? "ORM_O01 message has no ORC segment"
        : "No ORDER group with an OBR or RXO order detail found in ORM_O01 message",
    );
  }

  return entries;
}
