import type { PID, PV1, SCH } from "@health-samurai/interbox/hl7v2";
import { domainError } from "@health-samurai/interbox";
import { toKebabCase } from "./string.ts";

/**
 * Deterministic Patient.id from the first PID-3 repetition with a non-empty
 * value: kebab("<CX.4 namespace || CX.5 type || 'pid'>-<value>"),
 * e.g. "memorial-mrn-000123".
 */
export function patientIdFromPid(pid: PID): string {
  const cx = (pid.$3_identifier ?? []).find((rep) => rep.$1_value);
  if (!cx?.$1_value) {
    throw domainError(
      "field",
      "missing_patient_id",
      "PID-3 has no repetition with a non-empty identifier value",
    );
  }

  const scope = cx.$4_system?.$1_namespace || cx.$5_type || "pid";
  return toKebabCase(`${scope}-${cx.$1_value}`);
}

/**
 * Deterministic Encounter.id from PV1-19:
 * kebab("<PV1-19 CX.4 namespace || MSH-4 facility namespace>-<PV1-19 value>").
 * Returns undefined when PV1-19 has no value — the caller decides whether
 * that is field/missing_visit_number.
 */
export function encounterIdFromPv1(
  pv1: PV1,
  sendingFacility: string,
): string | undefined {
  const visitNumber = pv1.$19_visitNumber;
  if (!visitNumber?.$1_value) {
    return undefined;
  }

  const scope = visitNumber.$4_system?.$1_namespace || sendingFacility;
  return toKebabCase(`${scope}-${visitNumber.$1_value}`);
}

/**
 * Deterministic Appointment.id from SCH-2 (Filler Appointment ID), falling back
 * to SCH-1 (Placer Appointment ID):
 * kebab("<EI.2 namespace || MSH-4 facility>-<EI.1 value>[-<SCH-3 occurrence>]").
 *
 * The filler ID is preferred because the filler (the scheduling system) is the
 * SIU sender: it keeps that ID stable across the booking (S12), every
 * modification (S13/S14) and the cancellation (S15), so those messages land on
 * one Appointment instead of creating a new one each time. SCH-3 is part of the
 * id because a recurring appointment repeats one ID pair per occurrence.
 *
 * Returns undefined when neither field carries a value — the caller decides
 * whether that is field/missing_appointment_id.
 */
export function appointmentIdFromSch(
  sch: SCH,
  sendingFacility: string,
): string | undefined {
  const ei = sch.$2_fillerAppointmentId?.$1_value
    ? sch.$2_fillerAppointmentId
    : sch.$1_placerAppointmentId;
  if (!ei?.$1_value) {
    return undefined;
  }

  const scope = ei.$2_namespace || sendingFacility;
  const occurrence = sch.$3_occurrenceNumber?.trim();
  return toKebabCase(
    `${scope}-${ei.$1_value}${occurrence ? `-${occurrence}` : ""}`,
  );
}
