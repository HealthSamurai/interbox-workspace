/**
 * HL7v2 ADT_A08 Message to FHIR Converter
 *
 * ADT_A08 - Update Patient Information
 *
 * Creates:
 * - Patient from PID
 *
 * PV1 is not converted for A08 — the update concerns patient demographics;
 * no Encounter is emitted.
 */

import type { HL7v2Segment } from "@health-samurai/interbox/hl7v2";
import { fromMSH, fromPID } from "@health-samurai/interbox/hl7v2";
import type { DomainResource } from "@health-samurai/interbox/fhir/4.0.1";
import { domainError } from "@health-samurai/interbox";
import { findSegment, requirePid } from "../support/segments.ts";
import { senderFromMsh } from "../support/msh.ts";
import { patientIdFromPid } from "../support/identity.ts";
import { convertPIDToPatient } from "../segments/pid-patient.ts";

// ============================================================================
// Main Converter Function
// ============================================================================

/**
 * Convert HL7v2 ADT_A08 message to FHIR resources
 *
 * Message Structure:
 * MSH - Message Header (1)
 * EVN - Event Type (1)
 * PID - Patient Identification (1)
 */
export function convertADT_A08(parsed: HL7v2Segment[]): DomainResource[] {
  // =========================================================================
  // Extract MSH
  // =========================================================================
  const mshSegment = findSegment(parsed, "MSH");
  if (!mshSegment) {
    throw domainError("parse", "missing_msh", "MSH segment not found in ADT_A08 message");
  }
  const msh = fromMSH(mshSegment);
  senderFromMsh(msh); // validates MSH-3.1/MSH-4.1 (field/missing_sender)

  // =========================================================================
  // Extract PID -> Patient
  // =========================================================================
  const pid = fromPID(requirePid(parsed));
  const patient = convertPIDToPatient(pid);
  patient.id = patientIdFromPid(pid);

  return [patient];
}
