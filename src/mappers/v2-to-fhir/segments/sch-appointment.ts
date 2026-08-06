/**
 * HL7v2 SCH Segment to FHIR Appointment Mapping
 *
 * SCH carries the appointment itself; the timing comes from TQ1 (v2.5+) or the
 * deprecated SCH-11 TQ field (v2.4 senders), and the scheduled services from the
 * AIS segments of every resource group.
 *
 * Mapping:
 * - SCH.1  -> identifier (placer appointment id)
 * - SCH.2  -> identifier (filler appointment id)
 * - SCH.6  -> description (event reason text)
 * - SCH.7  -> reasonCode
 * - SCH.8  -> appointmentType
 * - SCH.9/10 -> minutesDuration
 * - SCH.11 -> start/end (v2.4 senders; superseded by TQ1)
 * - SCH.25 -> status (HL7 table 0278), else inferred from the trigger event
 * - AIS.3  -> serviceType
 * - AIS.4/7/8 -> start/duration fallback when SCH and TQ1 carry no timing
 */

import type { AIS, SCH, TQ1 } from "@health-samurai/interbox/hl7v2";
import type {
  Appointment,
  CodeableConcept,
  Identifier,
} from "@health-samurai/interbox/fhir/4.0.1";
import { domainError } from "@health-samurai/interbox";
import { convertCEToCodeableConcept } from "../datatypes/ce-codeableconcept.ts";
import { convertDTMToDateTime } from "../support/datetime.ts";

const PLACER_APPOINTMENT_ID_SYSTEM = "urn:hl7v2:sch-1:placer-appointment-id";
const FILLER_APPOINTMENT_ID_SYSTEM = "urn:hl7v2:sch-2:filler-appointment-id";

/**
 * HL7 table 0278 (Filler Status Code) -> FHIR AppointmentStatus.
 * Keys are lowercased before lookup because senders differ on case.
 */
const FILLER_STATUS_TO_APPOINTMENT_STATUS: Record<string, Appointment["status"]> = {
  pending: "pending",
  waitlist: "waitlist",
  booked: "booked",
  started: "checked-in",
  complete: "fulfilled",
  cancelled: "cancelled",
  canceled: "cancelled",
  dc: "cancelled",       // Discontinued
  deleted: "entered-in-error",
  blocked: "entered-in-error",
  overbook: "booked",
  noshow: "noshow",
};

/**
 * SIU trigger event -> FHIR AppointmentStatus, used when SCH-25 is absent or
 * carries a code outside table 0278.
 *
 * S18–S22 add, cancel, discontinue or delete a *service or resource* on an
 * existing appointment, and S22 blocks a slot: the appointment (or the block)
 * still occupies its time, so they stay booked. S23 reopens a blocked slot,
 * which retires the block. FHIR has no "discontinued", so S16 lands on
 * cancelled; only a deletion (S17) is entered-in-error.
 */
const TRIGGER_EVENT_TO_APPOINTMENT_STATUS: Record<string, Appointment["status"]> = {
  S12: "booked",           // New appointment booking
  S13: "booked",           // Appointment rescheduling
  S14: "booked",           // Appointment modification
  S15: "cancelled",        // Appointment cancellation
  S16: "cancelled",        // Appointment discontinuation
  S17: "entered-in-error", // Appointment deletion
  S18: "booked",           // Addition of service/resource
  S19: "booked",           // Cancellation of service/resource
  S20: "booked",           // Discontinuation of service/resource
  S21: "booked",           // Deletion of service/resource
  S22: "booked",           // Blocked schedule time slot(s)
  S23: "cancelled",        // Opened ("unblocked") schedule time slot(s)
  S24: "noshow",           // Patient did not show up
  S26: "noshow",           // Notification that patient did not show up
};

/** Duration units (HL7 table 0335 and the abbreviations senders actually use) -> minutes. */
const DURATION_UNIT_MINUTES: Record<string, number> = {
  s: 1 / 60,
  sec: 1 / 60,
  min: 1,
  mins: 1,
  minute: 1,
  minutes: 1,
  h: 60,
  hr: 60,
  hrs: 60,
  hour: 60,
  hours: 60,
  d: 1440,
  day: 1440,
  days: 1440,
};

/**
 * Resolve AppointmentStatus. SCH-25 wins when it maps: the filler states the
 * appointment's status directly, while the trigger event only says what kind of
 * notification this is (an S14 modification, for instance, can carry a
 * "Cancelled" filler status).
 */
export function resolveAppointmentStatus(
  sch: SCH,
  triggerEvent: string,
): Appointment["status"] {
  const fillerStatus = sch.$25_fillerStatusCode?.$1_code?.trim().toLowerCase();
  const fromFiller = fillerStatus
    ? FILLER_STATUS_TO_APPOINTMENT_STATUS[fillerStatus]
    : undefined;
  if (fromFiller) {
    return fromFiller;
  }

  const fromEvent = TRIGGER_EVENT_TO_APPOINTMENT_STATUS[triggerEvent.toUpperCase()];
  if (fromEvent) {
    return fromEvent;
  }

  throw domainError(
    "field",
    "unknown_appointment_status",
    `cannot resolve Appointment.status: SCH-25 is "${sch.$25_fillerStatusCode?.$1_code ?? ""}" ` +
      `and trigger event ${triggerEvent} has no status mapping`,
  );
}

/**
 * HL7 DTM -> FHIR instant.
 *
 * A date-only value (senders do use YYYYMMDD for all-day slots) is widened to
 * midnight rather than dropped, since Appointment.start/end are instants and
 * convertDTMToDateTime would leave "2026-04-23" — not a valid instant.
 *
 * Anything coarser than a day is rejected instead of widened: a year or a month
 * says nothing about when the appointment is, and one of the fields read here
 * (SCH-11.1) legitimately holds a *count* for senders that follow the TQ
 * datatype, which must not be mistaken for a date.
 */
function toInstant(dtm: string | undefined): string | undefined {
  const trimmed = dtm?.trim();
  if (!trimmed || !/^\d{8}/.test(trimmed)) {
    return undefined;
  }

  const value = convertDTMToDateTime(trimmed);
  if (!value) {
    return undefined;
  }
  return value.includes("T") ? value : `${value}T00:00:00Z`;
}

/** Add minutes to an instant produced by toInstant(). */
function addMinutes(instant: string, minutes: number): string | undefined {
  const parsed = Date.parse(instant);
  if (Number.isNaN(parsed)) {
    return undefined;
  }
  return `${new Date(parsed + minutes * 60_000).toISOString().slice(0, 19)}Z`;
}

/** Duration + units -> whole minutes, or undefined when either is unusable. */
function toMinutes(
  duration: string | undefined,
  units: string | undefined,
): number | undefined {
  const value = Number(duration?.trim());
  if (!duration?.trim() || Number.isNaN(value) || value <= 0) {
    return undefined;
  }

  // HL7 defaults SCH-10/AIS-8 to minutes when the sender omits them.
  const factor = units?.trim()
    ? DURATION_UNIT_MINUTES[units.trim().toLowerCase()]
    : 1;
  if (factor === undefined) {
    return undefined;
  }

  const minutes = Math.round(value * factor);
  return minutes > 0 ? minutes : undefined;
}

function buildIdentifiers(sch: SCH): Identifier[] {
  const identifiers: Identifier[] = [];

  const placer = sch.$1_placerAppointmentId;
  if (placer?.$1_value) {
    identifiers.push({
      system: PLACER_APPOINTMENT_ID_SYSTEM,
      value: placer.$1_value,
      ...(placer.$2_namespace && { assigner: { display: placer.$2_namespace } }),
    });
  }

  const filler = sch.$2_fillerAppointmentId;
  if (filler?.$1_value) {
    identifiers.push({
      system: FILLER_APPOINTMENT_ID_SYSTEM,
      value: filler.$1_value,
      ...(filler.$2_namespace && { assigner: { display: filler.$2_namespace } }),
    });
  }

  return identifiers;
}

/**
 * Resolve start/end/minutesDuration.
 *
 * Precedence for the start: TQ1-7, then SCH-11.4 (TQ.4 "start date/time"), then
 * SCH-11.1.1, then AIS-4. That third step looks wrong but is not: MEDITECH (and
 * other v2.4 senders) put the appointment datetime in the TQ *quantity*
 * component and never populate TQ.4, so reading only TQ.4 loses the appointment
 * time for every one of those messages.
 *
 * The end is taken from TQ1-8 or SCH-11.5 when present, and otherwise computed
 * from the duration (SCH-9/10, falling back to AIS-7/8).
 */
function resolveTiming(
  sch: SCH,
  tq1: TQ1 | undefined,
  services: AIS[],
): { start?: string; end?: string; minutesDuration?: number } {
  // Recurring appointments repeat SCH-11/TQ1 per occurrence; only the first is
  // mapped, since one SIU message becomes one Appointment here.
  const schTiming = sch.$11_appointmentTimingQuantity?.[0];
  const firstService = services[0];

  const start =
    toInstant(tq1?.$7_start) ??
    toInstant(schTiming?.$4_start) ??
    toInstant(schTiming?.$1_value?.$1_value) ??
    toInstant(firstService?.$4_startOfServiceDateTime);

  const minutesDuration =
    toMinutes(sch.$9_appointmentDuration, sch.$10_appointmentDurationUnits?.$1_code) ??
    toMinutes(firstService?.$7_duration, firstService?.$8_durationUnits?.$1_code);

  const explicitEnd = toInstant(tq1?.$8_end) ?? toInstant(schTiming?.$5_end);
  const end =
    explicitEnd ??
    (start && minutesDuration !== undefined
      ? addMinutes(start, minutesDuration)
      : undefined);

  return {
    ...(start && { start }),
    ...(end && { end }),
    ...(minutesDuration !== undefined && { minutesDuration }),
  };
}

/** Scheduled services (AIS-3) across every resource group, de-duplicated by code. */
function buildServiceTypes(services: AIS[]): CodeableConcept[] {
  const byCode = new Map<string, CodeableConcept>();

  for (const ais of services) {
    const concept = convertCEToCodeableConcept(ais.$3_universalServiceIdentifier);
    if (!concept) {
      continue;
    }
    const key =
      ais.$3_universalServiceIdentifier?.$1_code ??
      ais.$3_universalServiceIdentifier?.$2_text ??
      "";
    if (!byCode.has(key)) {
      byCode.set(key, concept);
    }
  }

  return [...byCode.values()];
}

/**
 * Convert SCH (plus TQ1 and the message's AIS segments) to a FHIR Appointment.
 *
 * The caller owns `id` and `participant`: ids are scoped by the sending facility
 * (see appointmentIdFromSch) and participants are assembled from PID, AIL and
 * AIP across the resource groups.
 */
export function convertSCHToAppointment(
  sch: SCH,
  triggerEvent: string,
  tq1: TQ1 | undefined,
  services: AIS[],
): Appointment {
  const identifier = buildIdentifiers(sch);
  const serviceType = buildServiceTypes(services);
  const reasonCode = convertCEToCodeableConcept(sch.$7_appointmentReason);
  const appointmentType = convertCEToCodeableConcept(sch.$8_appointmentType);
  const description = sch.$6_eventReason?.$2_text ?? sch.$6_eventReason?.$1_code;

  return {
    resourceType: "Appointment",
    status: resolveAppointmentStatus(sch, triggerEvent),
    ...(identifier.length > 0 && { identifier }),
    ...(serviceType.length > 0 && { serviceType }),
    ...(appointmentType && { appointmentType }),
    ...(reasonCode && { reasonCode: [reasonCode] }),
    ...(description && { description }),
    ...resolveTiming(sch, tq1, services),
    // Required by FHIR (1..*); the caller fills it from PID/AIL/AIP.
    participant: [],
  };
}
