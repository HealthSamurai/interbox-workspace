/**
 * HL7v2 RXO Segment to FHIR MedicationRequest Converter
 * Based on: HL7 Segment - FHIR R4_ RXO[MedicationRequest] - Sheet1.csv
 *
 * Converts an RXO segment into a MedicationRequest resource.
 * Status is resolved externally by the ORC-based resolveOrderStatus() and
 * passed in as a parameter, with "revoked" adapted to "cancelled" for
 * MedicationRequest type compatibility.
 */

import type { RXO } from "@health-samurai/interbox/hl7v2";
import type {
  MedicationRequest,
  MedicationRequestDispenseRequest,
  MedicationRequestSubstitution,
  CodeableConcept,
  Dosage,
  Quantity,
  Range,
} from "@health-samurai/interbox/fhir/4.0.1";
import { convertCEToCodeableConcept } from "../datatypes/ce-codeableconcept.ts";

type DosageDoseAndRate = NonNullable<Dosage["doseAndRate"]>[number];

/**
 * Valid MedicationRequest.status values.
 * "revoked" is NOT valid for MedicationRequest -- it must be mapped to "cancelled".
 */
type MedicationRequestStatus = MedicationRequest["status"];

const STATUS_ADAPTATION: Record<string, MedicationRequestStatus> = {
  revoked: "cancelled",
};

/**
 * Adapt a request-status value resolved from ORC to MedicationRequest.status.
 *
 * ORM reuses ORC status resolution for both ServiceRequest and MedicationRequest.
 * FHIR R4 differs here: ServiceRequest uses "revoked" while MedicationRequest
 * uses "cancelled", so we translate only this incompatible value.
 */
function adaptStatusForMedicationRequest(status: string): MedicationRequestStatus {
  return (STATUS_ADAPTATION[status] ?? status) as MedicationRequestStatus;
}

/**
 * Build unit Quantity from a CE field (code system for units).
 * Uses code from CE.1 and display from CE.2, system from CE.3.
 */
type UnitCE = { $1_code?: string; $2_text?: string; $3_system?: string };
function buildUnitQuantity(value: number, unitCE: UnitCE): Quantity {
  return {
    value,
    ...(unitCE.$1_code && { code: unitCE.$1_code, unit: unitCE.$1_code }),
    ...(unitCE.$3_system && { system: unitCE.$3_system }),
  };
}

/**
 * Build doseRange from RXO-2 (min), RXO-3 (max), RXO-4 (units).
 * When only RXO-2 is present (no max), produces a Range with low only.
 */
function buildDoseRange(rxo: RXO): Range | undefined {
  const minStr = rxo.$2_requestedGiveAmountMinimum;
  if (!minStr) {return undefined;}

  const minValue = parseFloat(minStr);
  if (isNaN(minValue)) {return undefined;}

  const units = rxo.$4_requestedGiveUnit;
  const range: Range = {};

  range.low = units
    ? buildUnitQuantity(minValue, units)
    : { value: minValue };

  const maxStr = rxo.$3_requestedGiveAmountMaximum;
  if (maxStr) {
    const maxValue = parseFloat(maxStr);
    if (!isNaN(maxValue)) {
      range.high = units
        ? buildUnitQuantity(maxValue, units)
        : { value: maxValue };
    }
  }

  return range;
}

/**
 * Build substitution from RXO-9 (Allow Substitutions).
 * "Y"/"T" -> allowed, "N" -> not allowed.
 */
function buildSubstitution(allowSubstitutions: string): MedicationRequestSubstitution | undefined {
  const normalized = allowSubstitutions.toUpperCase();

  let concept: CodeableConcept;
  if (normalized === "Y" || normalized === "T") {
    concept = {
      coding: [{ code: "E", display: "Equivalent", system: "http://terminology.hl7.org/CodeSystem/v3-substanceAdminSubstitution" }],
    };
  } else if (normalized === "N") {
    concept = {
      coding: [{ code: "N", display: "None", system: "http://terminology.hl7.org/CodeSystem/v3-substanceAdminSubstitution" }],
    };
  } else {
    return undefined;
  }

  return { allowedCodeableConcept: concept };
}

/**
 * Build dispenseRequest from RXO-11 (amount), RXO-12 (units), RXO-13 (refills).
 */
function buildDispenseRequest(rxo: RXO): MedicationRequestDispenseRequest | undefined {
  const dispense: MedicationRequestDispenseRequest = {};
  let hasContent = false;

  // RXO-11/12: Requested Dispense Amount + Units -> quantity
  if (rxo.$11_requestedDispenseAmount) {
    const dispenseValue = parseFloat(rxo.$11_requestedDispenseAmount);
    if (!isNaN(dispenseValue)) {
      const quantity: Quantity = { value: dispenseValue };
      const units = rxo.$12_requestedDispenseUnit;
      if (units?.$1_code) {
        quantity.code = units.$1_code;
        quantity.unit = units.$1_code;
      }
      if (units?.$3_system) {
        quantity.system = units.$3_system;
      }
      dispense.quantity = quantity;
      hasContent = true;
    }
  }

  // RXO-13: Number of Refills -> numberOfRepeatsAllowed
  if (rxo.$13_numberOfRefills) {
    const refills = parseInt(rxo.$13_numberOfRefills, 10);
    if (!isNaN(refills)) {
      dispense.numberOfRepeatsAllowed = refills;
      hasContent = true;
    }
  }

  return hasContent ? dispense : undefined;
}

/**
 * Convert RXO segment to a partial MedicationRequest.
 *
 * The caller provides the resolved ORC status (from resolveOrderStatus()) and is
 * responsible for setting subject, encounter, and id on the returned resource.
 *
 * @param rxo - Parsed RXO segment
 * @param resolvedStatus - Status string from ORC resolution (may be "revoked" which
 *   gets adapted to "cancelled" for MedicationRequest compatibility)
 */
export function convertRXOToMedicationRequest(rxo: RXO, resolvedStatus: string): Partial<MedicationRequest> {
  const medicationRequest: Partial<MedicationRequest> = {
    resourceType: "MedicationRequest",
    intent: "original-order",
    status: adaptStatusForMedicationRequest(resolvedStatus),
  };

  // RXO-1: Requested Give Code -> medicationCodeableConcept
  const medicationCode = convertCEToCodeableConcept(rxo.$1_requestedGiveCode);
  if (medicationCode) {
    medicationRequest.medicationCodeableConcept = medicationCode;
  }

  // RXO-2/3/4: Dose range -> dosageInstruction[0].doseAndRate[0].doseRange
  const doseRange = buildDoseRange(rxo);
  if (doseRange) {
    const doseAndRate: DosageDoseAndRate = { doseRange };
    medicationRequest.dosageInstruction = [{ doseAndRate: [doseAndRate] }];
  }

  // RXO-9: Allow Substitutions -> substitution.allowedCodeableConcept
  if (rxo.$9_allowSubstitutions) {
    const substitution = buildSubstitution(rxo.$9_allowSubstitutions);
    if (substitution) {
      medicationRequest.substitution = substitution;
    }
  }

  // RXO-11/12/13: Dispense request
  const dispenseRequest = buildDispenseRequest(rxo);
  if (dispenseRequest) {
    medicationRequest.dispenseRequest = dispenseRequest;
  }

  return medicationRequest;
}
