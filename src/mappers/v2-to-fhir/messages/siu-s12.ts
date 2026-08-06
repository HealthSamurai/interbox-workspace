/**
 * HL7v2 SIU_S12 Message to FHIR Converter
 *
 * SIU_S12 is the message structure every SIU trigger event shares (S12 booking
 * through S26 no-show), so this one converter serves all of them and reads the
 * trigger event only to infer a status when SCH-25 does not carry one.
 *
 * Creates:
 * - Appointment from SCH (+ TQ1, AIS, NTE)
 * - Patient[] from PID[]
 * - Location[] from AIL[] across every resource group
 * - Practitioner[] from AIP[] across every resource group
 *
 * Everything the appointment needs to reference is emitted alongside it, and each
 * one appears once even when several resource groups name the same room or
 * clinician.
 *
 * Not mapped: AIG (equipment and other general resources). FHIR would model those
 * as Device or HealthcareService participants, which this mapper does not produce
 * — the same line the reference parser draws.
 *
 * Encounters are left to ADT, as in ORM_O01: a scheduling message says what is
 * planned, not what happened, and R4 links the two from Encounter.appointment.
 */

import type { AIS, HL7v2Message, HL7v2Segment } from "@health-samurai/interbox/hl7v2";
import {
  fromAIL,
  fromAIP,
  fromAIS,
  fromMSH,
  fromNTE,
  fromPID,
  fromSCH,
  fromTQ1,
} from "@health-samurai/interbox/hl7v2";
import type {
  Appointment,
  AppointmentParticipant,
  CodeableConcept,
  DomainResource,
  Location,
  Patient,
  Practitioner,
  Reference,
} from "@health-samurai/interbox/fhir/4.0.1";
import { domainError } from "@health-samurai/interbox";
import { findSegment, findAllSegments } from "../support/segments.ts";
import { senderFromMsh } from "../support/msh.ts";
import { appointmentIdFromSch, patientIdFromPid } from "../support/identity.ts";
import { convertPIDToPatient } from "../segments/pid-patient.ts";
import { convertNTEsToAnnotation } from "../segments/nte-annotation.ts";
import { convertSCHToAppointment } from "../segments/sch-appointment.ts";
import { convertAILToLocation } from "../segments/ail-location.ts";
import { convertCEToCodeableConcept } from "../datatypes/ce-codeableconcept.ts";
import {
  buildPractitionerIdFromXCN,
  convertXCNToPractitioner,
} from "../datatypes/xcn-practitioner.ts";

const PARTICIPATION_TYPE_SYSTEM = "http://terminology.hl7.org/CodeSystem/v3-ParticipationType";

/** Participation type used for an AIP that does not say what the person's role is. */
const DEFAULT_PERSONNEL_TYPE: CodeableConcept = {
  coding: [{ system: PARTICIPATION_TYPE_SYSTEM, code: "ATND", display: "attender" }],
};

/**
 * NTE segments that belong to the appointment as a whole: the ones before the
 * first RGS. NTEs inside a resource group annotate that service or resource, not
 * the appointment, so they are left out of Appointment.comment.
 */
function appointmentNotes(message: HL7v2Message): HL7v2Segment[] {
  const firstRgs = message.findIndex((s) => s.segment === "RGS");
  const head = firstRgs === -1 ? message : message.slice(0, firstRgs);
  return head.filter((s) => s.segment === "NTE");
}

/** Patients, plus a participant for each, from the message's PID segments. */
function buildPatients(message: HL7v2Message): {
  patients: Patient[];
  participants: AppointmentParticipant[];
} {
  const patients: Patient[] = [];
  const participants: AppointmentParticipant[] = [];
  const seen = new Set<string>();

  for (const segment of findAllSegments(message, "PID")) {
    const pid = fromPID(segment);
    const patient = convertPIDToPatient(pid);
    patient.id = patientIdFromPid(pid);
    if (seen.has(patient.id)) {
      continue;
    }
    seen.add(patient.id);

    patients.push(patient);
    participants.push({
      actor: { reference: `Patient/${patient.id}` } as Reference<"Patient">,
      status: "accepted",
    });
  }

  return { patients, participants };
}

/** Locations, plus a participant for each, from the message's AIL segments. */
function buildLocations(
  message: HL7v2Message,
  sendingFacility: string,
): { locations: Location[]; participants: AppointmentParticipant[] } {
  const locations: Location[] = [];
  const participants: AppointmentParticipant[] = [];
  const seen = new Set<string>();

  for (const segment of findAllSegments(message, "AIL")) {
    const ail = fromAIL(segment);
    // AIL-3 repeats: a resource group can name several rooms at once.
    for (const pl of ail.$3_locationResourceId ?? []) {
      const location = convertAILToLocation({ ...ail, $3_locationResourceId: [pl] }, sendingFacility);
      if (!location?.id || seen.has(location.id)) {
        continue;
      }
      seen.add(location.id);

      locations.push(location);
      participants.push({
        actor: { reference: `Location/${location.id}` } as Reference<"Location">,
        status: "accepted",
      });
    }
  }

  return { locations, participants };
}

/** Practitioners, plus a participant for each, from the message's AIP segments. */
function buildPractitioners(message: HL7v2Message): {
  practitioners: Practitioner[];
  participants: AppointmentParticipant[];
} {
  const practitioners: Practitioner[] = [];
  const participants: AppointmentParticipant[] = [];
  const seen = new Set<string>();
  // Keyed by person *and* role: the same clinician can appear in two resource
  // groups as, say, the performer of one service and the attender of another, and
  // both belong on the appointment — but the same pair repeated does not.
  const seenRoles = new Set<string>();

  for (const segment of findAllSegments(message, "AIP")) {
    const aip = fromAIP(segment);
    // AIP-4 is the role the person plays in this appointment (HL7 table 0182).
    const type = convertCEToCodeableConcept(aip.$4_resourceType) ?? DEFAULT_PERSONNEL_TYPE;
    const roleKey = type.coding?.[0]?.code ?? type.text ?? "";

    // AIP-3 repeats: one segment can name several people in the same role.
    for (const xcn of aip.$3_personnelResourceId ?? []) {
      const id = buildPractitionerIdFromXCN(xcn);
      const practitioner = convertXCNToPractitioner(xcn);
      // No XCN.1 means nothing stable to key the Practitioner on, and a
      // reference to it would dangle — skip rather than mint a random id.
      if (!id || !practitioner) {
        continue;
      }

      if (!seen.has(id)) {
        seen.add(id);
        practitioner.id = id;
        practitioners.push(practitioner);
      }

      if (seenRoles.has(`${id}|${roleKey}`)) {
        continue;
      }
      seenRoles.add(`${id}|${roleKey}`);

      participants.push({
        type: [type] as AppointmentParticipant["type"],
        actor: { reference: `Practitioner/${id}` } as Reference<"Practitioner">,
        status: "accepted",
      });
    }
  }

  return { practitioners, participants };
}

/** Every AIS in the message, in order — the appointment's scheduled services. */
function scheduledServices(message: HL7v2Message): AIS[] {
  return findAllSegments(message, "AIS").map((segment) => fromAIS(segment));
}

/**
 * Convert an HL7v2 SIU message to a flat array of FHIR resources.
 *
 * Message Structure (v2.5):
 * MSH [1..1]
 * SCH [1..1]
 * TQ1 [0..*]      (timing; replaces the deprecated SCH-11)
 * NTE [0..*]      (appointment-level notes)
 * PATIENT [0..*]
 *   PID [1..1], PV1 [0..1], …
 * RESOURCES [1..*]
 *   RGS [1..1]
 *   SERVICE [0..*]            AIS [1..1], NTE [0..*]
 *   GENERAL_RESOURCE [0..*]   AIG [1..1], NTE [0..*]
 *   LOCATION_RESOURCE [0..*]  AIL [1..1], NTE [0..*]
 *   PERSONNEL_RESOURCE [0..*] AIP [1..1], NTE [0..*]
 *
 * @param triggerEvent MSH-9.2 (S12, S14, S15, …) — the fallback for a status
 *   SCH-25 does not give.
 */
export function convertSIU_S12(
  parsed: HL7v2Message,
  triggerEvent: string,
): DomainResource[] {
  const mshSegment = findSegment(parsed, "MSH");
  if (!mshSegment) {
    throw domainError("parse", "missing_msh", "MSH segment not found in SIU message");
  }
  const { sendingFacility } = senderFromMsh(fromMSH(mshSegment));

  const schSegment = findSegment(parsed, "SCH");
  if (!schSegment) {
    throw domainError(
      "structure",
      "missing_sch",
      "SCH segment is required for SIU but missing",
    );
  }
  const sch = fromSCH(schSegment);

  const appointmentId = appointmentIdFromSch(sch, sendingFacility);
  if (!appointmentId) {
    throw domainError(
      "field",
      "missing_appointment_id",
      "SCH-1 (Placer Appointment ID) and SCH-2 (Filler Appointment ID) are both empty",
    );
  }

  const tq1Segment = findSegment(parsed, "TQ1");
  const appointment: Appointment = convertSCHToAppointment(
    sch,
    triggerEvent,
    tq1Segment ? fromTQ1(tq1Segment) : undefined,
    scheduledServices(parsed),
  );
  appointment.id = appointmentId;

  const notes = appointmentNotes(parsed).map((segment) => fromNTE(segment));
  const comment = convertNTEsToAnnotation(notes)?.text;
  if (comment) {
    appointment.comment = comment;
  }

  // A blocked-slot notification (S22/S23) carries no PID, so the patient
  // participant is genuinely optional here.
  const { patients, participants: patientParticipants } = buildPatients(parsed);
  const { locations, participants: locationParticipants } = buildLocations(parsed, sendingFacility);
  const { practitioners, participants: practitionerParticipants } = buildPractitioners(parsed);

  appointment.participant = [
    ...patientParticipants,
    ...practitionerParticipants,
    ...locationParticipants,
  ];
  if (appointment.participant.length === 0) {
    throw domainError(
      "structure",
      "missing_appointment_participant",
      "SIU message names no patient (PID), personnel (AIP) or location (AIL); " +
        "FHIR requires at least one Appointment.participant",
    );
  }

  return [appointment, ...patients, ...practitioners, ...locations];
}
