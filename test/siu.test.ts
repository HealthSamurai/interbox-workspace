import { expect, test } from "bun:test";
import { parseHl7v2, type HL7v2Segment } from "@health-samurai/interbox/hl7v2";
import type {
  Appointment,
  Location,
  Patient,
  Practitioner,
} from "@health-samurai/interbox/fhir/4.0.1";
import { convertToFhir } from "../src/mappers/v2-to-fhir/index.ts";

// The SIU corpus these expectations were built against is MEDITECH v2.4: no TQ1,
// the appointment datetime in SCH-11.1 rather than SCH-11.4, notes between PV1 and
// the first RGS, one resource group per appointment.
const MEDITECH_S12 = [
  "MSH|^~\\&|CWS|BMH|||202603201318||SIU^S12|260884663|P|2.4|||AL|NE",
  "EVN|S12|202603201317||BOOK|JJM675^Morehead^James^J^^^^^^^^^XX",
  "SCH|BH2-B20260303145038026|T0-B20260303145037916|||MRTHORACICG^MRI Thoracic GAD|BOOK|Disease of spinal cord, unspecified|Normal^Scheduled|30|min|202604231500|||||||||JJM675^Morehead^James^J^^^^^^^^^XX",
  "PID|1|6579143^^^OCCAM^PE|M000008833^^^MEDITECH^MR||Difvnx^Rjnckfdu^O^^^^L|Flkkags|19580101|F",
  "PV1|1|P|BXBC260MRI|EL|||APHO^Appleberry^Holly^Carolyn^^^DO^^^^^^XX",
  "ROL|1|AD|PP|DICWC.MD^DiCuccio^William^C^^^MD^^^^^^XX",
  "NTE|1||*Complete screening assessment",
  "NTE|2||*Arrive 30 minutes prior to exam, 260 Butler Commons",
  "RGS|1||MRRMBC^MRI^MRI",
  "AIS|1||MRRMBC^MRI Room (BC)|202604231500|||30|min||Booked",
  "AIL|1||BXBC260MRI^Butler Commons 260 MRI|Outpatient",
  "AIP|1|A|APHO^Appleberry^Holly^Carolyn^^^DO^^^^^^XX|NS^Non-Staff",
].join("\r");

async function convert(raw: string): Promise<Record<string, unknown>[]> {
  const segments = parseHl7v2(raw) as unknown as HL7v2Segment[];
  return (await convertToFhir(segments)) as Record<string, unknown>[];
}

function pick<T>(resources: Record<string, unknown>[], resourceType: string): T[] {
  return resources.filter((r) => r["resourceType"] === resourceType) as T[];
}

async function appointmentOf(raw: string): Promise<Appointment> {
  const appointments = pick<Appointment>(await convert(raw), "Appointment");
  expect(appointments).toHaveLength(1);
  return appointments[0]!;
}

test("a MEDITECH SIU^S12 becomes one Appointment plus everything it references", async () => {
  const resources = await convert(MEDITECH_S12);

  const appointment = pick<Appointment>(resources, "Appointment")[0]!;
  const patients = pick<Patient>(resources, "Patient");
  const practitioners = pick<Practitioner>(resources, "Practitioner");
  const locations = pick<Location>(resources, "Location");

  expect(appointment.id).toBe("bmh-t0-b20260303145037916");
  expect(appointment.status).toBe("booked");
  expect(appointment.identifier).toEqual([
    {
      system: "urn:hl7v2:sch-1:placer-appointment-id",
      value: "BH2-B20260303145038026",
    },
    {
      system: "urn:hl7v2:sch-2:filler-appointment-id",
      value: "T0-B20260303145037916",
    },
  ]);

  // SCH-11.1 carries the datetime for this sender; SCH-9/10 give the duration,
  // and the end is derived from the two.
  expect(appointment.start).toBe("2026-04-23T15:00:00Z");
  expect(appointment.end).toBe("2026-04-23T15:30:00Z");
  expect(appointment.minutesDuration).toBe(30);

  expect(appointment.description).toBe("BOOK");
  expect(appointment.appointmentType?.coding?.[0]).toMatchObject({ code: "Normal", display: "Scheduled" });
  expect(appointment.reasonCode?.[0]?.coding?.[0]?.code).toBe("Disease of spinal cord, unspecified");
  expect(appointment.serviceType?.[0]?.coding?.[0]).toMatchObject({
    code: "MRRMBC",
    display: "MRI Room (BC)",
  });
  expect(appointment.comment).toBe(
    "*Complete screening assessment\n*Arrive 30 minutes prior to exam, 260 Butler Commons",
  );

  // One participant per referenced resource: patient, then personnel, then location.
  // PID-2 holds MEDITECH's external id and PID-3 the MRN, so the MRN is what
  // patientIdFromPid keys on.
  expect(appointment.participant.map((p) => p.actor?.reference)).toEqual([
    "Patient/meditech-m000008833",
    "Practitioner/apho",
    "Location/bmh-bxbc260mri-butler-commons-260-mri",
  ]);
  expect(appointment.participant.every((p) => p.status === "accepted")).toBe(true);
  expect(appointment.participant[1]?.type?.[0]?.coding?.[0]).toMatchObject({
    code: "NS",
    display: "Non-Staff",
  });

  expect(patients.map((p) => p.id)).toEqual(["meditech-m000008833"]);
  expect(practitioners[0]).toMatchObject({
    id: "apho",
    name: [{ family: "Appleberry", given: ["Holly", "Carolyn"] }],
  });
  expect(locations[0]).toMatchObject({
    id: "bmh-bxbc260mri-butler-commons-260-mri",
    name: "BXBC260MRI",
    description: "Point of care BXBC260MRI, Room Butler Commons 260 MRI",
    physicalType: { coding: [{ code: "ro" }] },
    type: [{ coding: [{ code: "Outpatient" }] }],
  });

  // Every reference in the Appointment resolves inside the same bundle.
  const ids = new Set(resources.map((r) => `${r["resourceType"]}/${r["id"]}`));
  for (const participant of appointment.participant) {
    expect(ids.has(participant.actor?.reference ?? "")).toBe(true);
  }
});

test("later events land on the appointment the booking created", async () => {
  const booked = await appointmentOf(MEDITECH_S12);

  // Same SCH-2, new trigger event and a filler status: the S15 has to update the
  // S12's Appointment rather than create a second one.
  const cancelled = await appointmentOf(
    MEDITECH_S12.replace("SIU^S12", "SIU^S15").replace("|EVN|S12", "|EVN|S15"),
  );

  expect(cancelled.id).toBe(booked.id);
  expect(cancelled.status).toBe("cancelled");
});

test("SCH-25 decides the status, and the trigger event fills in when it is empty", async () => {
  const withFillerStatus = [
    "MSH|^~\\&|SCHED|HC|||20260601120000||SIU^S14^SIU_S12|MSG2|P|2.5",
    // 24 pipes carry the segment out to SCH-25.
    `SCH|PLC-1|FIL-1${"|".repeat(23)}Cancelled`,
    "TQ1|1||||||202606011400|202606011430",
    "PID|1||PT-1^^^HC^MR||Doe^Jane||19850315|F",
    "RGS|1|A",
    "AIL|1|A|CLINIC-A",
  ].join("\r");

  // An S14 (modification) carrying a cancelled filler status is cancelled: the
  // filler states the appointment's status, the event only names the notification.
  const modified = await appointmentOf(withFillerStatus);
  expect(modified.status).toBe("cancelled");
  expect(modified.start).toBe("2026-06-01T14:00:00Z");
  expect(modified.end).toBe("2026-06-01T14:30:00Z");
  expect(modified.minutesDuration).toBeUndefined();

  // Same message without SCH-25 falls back to the event.
  const byEvent = async (event: string) =>
    (await appointmentOf(
      withFillerStatus.replace("SIU^S14^SIU_S12", `SIU^${event}^SIU_S12`).replace("Cancelled", ""),
    )).status;

  expect(await byEvent("S12")).toBe("booked");
  expect(await byEvent("S15")).toBe("cancelled");
  expect(await byEvent("S16")).toBe("cancelled");
  expect(await byEvent("S17")).toBe("entered-in-error");
  expect(await byEvent("S23")).toBe("cancelled");
  expect(await byEvent("S26")).toBe("noshow");
});

test("resources repeated across groups are emitted once and referenced once", async () => {
  // Two services in two resource groups, sharing a clinician and naming three
  // rooms — one of them twice, and one group repeats AIL-3 within a single field.
  const resources = await convert(
    [
      "MSH|^~\\&|SCHED|HC|||20260601120000||SIU^S12^SIU_S12|MSG3|P|2.5",
      // SCH-3 occurrence 1, SCH-9/10 duration 45 min, SCH-25 filler status.
      `SCH|PLC-2|FIL-2|1|||FOLLOWUP|||45|min${"|".repeat(15)}Booked`,
      "TQ1|1||||||202606020900",
      "PID|1||PT-2^^^HC^MR||Roe^Sam||19700202|M",
      "RGS|1|A|GRP-1",
      "AIS|1|A|XR-CHEST^Chest X-Ray",
      "AIL|1|A|IMAGING^ROOM-1^^SITE-A~IMAGING^ROOM-2^^SITE-A|C",
      "AIP|1|A|DOC-9^Vance^Ada^^^^MD|D^Physician",
      "RGS|2|A|GRP-2",
      "AIS|1|A|XR-SPINE^Spine X-Ray",
      "AIL|1|A|IMAGING^ROOM-1^^SITE-A|C",
      "AIP|1|A|DOC-9^Vance^Ada^^^^MD|D^Physician",
      "AIP|2|A|TECH-4^Bell^Ray|D^Technician",
    ].join("\r"),
  );

  const appointment = pick<Appointment>(resources, "Appointment")[0]!;
  const locations = pick<Location>(resources, "Location");
  const practitioners = pick<Practitioner>(resources, "Practitioner");

  // SCH-3 (occurrence number) is part of the id: a recurring appointment repeats
  // the same placer/filler pair once per occurrence.
  expect(appointment.id).toBe("hc-fil-2-1");

  expect(locations.map((l) => l.id)).toEqual([
    "site-a-imaging-room-1",
    "site-a-imaging-room-2",
  ]);
  expect(practitioners.map((p) => p.id)).toEqual(["doc-9", "tech-4"]);

  expect(appointment.participant.map((p) => p.actor?.reference)).toEqual([
    "Patient/hc-pt-2",
    "Practitioner/doc-9",
    "Practitioner/tech-4",
    "Location/site-a-imaging-room-1",
    "Location/site-a-imaging-room-2",
  ]);

  // Both AIS segments survive as service types.
  expect(appointment.serviceType?.map((s) => s.coding?.[0]?.code)).toEqual([
    "XR-CHEST",
    "XR-SPINE",
  ]);

  // No end datetime and a duration in SCH-9: the end is computed.
  expect(appointment.start).toBe("2026-06-02T09:00:00Z");
  expect(appointment.end).toBe("2026-06-02T09:45:00Z");
});

test("a blocked-slot notification maps without a patient", async () => {
  const resources = await convert(
    [
      "MSH|^~\\&|SCHED|HC|||20260601120000||SIU^S23^SIU_S12|MSG4|P|2.5",
      `SCH|PLC-3|FIL-3${"|".repeat(23)}Deleted`,
      "TQ1|1||||||202606030800|202606031200",
      "RGS|1|A",
      "AIL|1|A|CLINIC-B^^^SITE-B",
    ].join("\r"),
  );

  expect(pick<Patient>(resources, "Patient")).toHaveLength(0);
  const appointment = pick<Appointment>(resources, "Appointment")[0]!;
  expect(appointment.status).toBe("entered-in-error"); // SCH-25 "Deleted"
  expect(appointment.participant.map((p) => p.actor?.reference)).toEqual([
    "Location/site-b-clinic-b",
  ]);
});

test("duration units other than minutes are converted", async () => {
  const appointment = await appointmentOf(
    [
      "MSH|^~\\&|SCHED|HC|||20260601120000||SIU^S12^SIU_S12|MSG5|P|2.5",
      "SCH|PLC-4|FIL-4|||||||2|hr|202606040800",
      "RGS|1|A",
      "AIL|1|A|CLINIC-C",
    ].join("\r"),
  );

  expect(appointment.minutesDuration).toBe(120);
  expect(appointment.start).toBe("2026-06-04T08:00:00Z");
  expect(appointment.end).toBe("2026-06-04T10:00:00Z");
});

test("a TQ quantity that is a count, not a datetime, is not read as timing", async () => {
  // A sender following the TQ datatype puts the number of occurrences in
  // SCH-11.1 and the datetime in SCH-11.4. Reading .1 for the MEDITECH dialect
  // must not turn that count into a start instant.
  const appointment = await appointmentOf(
    [
      "MSH|^~\\&|SCHED|HC|||20260601120000||SIU^S12^SIU_S12|MSG8|P|2.4",
      "SCH|PLC-6|FIL-6|||||||30|min|1^^^202606061100^202606061130",
      "PID|1||PT-6^^^HC^MR",
      "RGS|1|A",
      "AIL|1|A|CLINIC-E",
    ].join("\r"),
  );

  expect(appointment.start).toBe("2026-06-06T11:00:00Z");
  expect(appointment.end).toBe("2026-06-06T11:30:00Z");
});

test("timing coarser than a day is left off rather than widened", async () => {
  const appointment = await appointmentOf(
    [
      "MSH|^~\\&|SCHED|HC|||20260601120000||SIU^S12^SIU_S12|MSG9|P|2.4",
      "SCH|PLC-8|FIL-8|||||||30|min|202606",
      "PID|1||PT-8^^^HC^MR",
      "RGS|1|A",
      "AIL|1|A|CLINIC-F",
    ].join("\r"),
  );

  expect(appointment.start).toBeUndefined();
  expect(appointment.end).toBeUndefined();
  expect(appointment.minutesDuration).toBe(30);
});

test("a date-only appointment time becomes midnight", async () => {
  const appointment = await appointmentOf(
    [
      "MSH|^~\\&|SCHED|HC|||20260601120000||SIU^S12^SIU_S12|MSG10|P|2.5",
      "SCH|PLC-9|FIL-9",
      "TQ1|1||||||20260607",
      "PID|1||PT-9^^^HC^MR",
      "RGS|1|A",
      "AIL|1|A|CLINIC-G",
    ].join("\r"),
  );

  expect(appointment.start).toBe("2026-06-07T00:00:00Z");
});

test("AIS timing is used when neither TQ1 nor SCH carries any", async () => {
  const appointment = await appointmentOf(
    [
      "MSH|^~\\&|SCHED|HC|||20260601120000||SIU^S12^SIU_S12|MSG6|P|2.5",
      "SCH|PLC-5|FIL-5",
      "RGS|1|A",
      "AIS|1|A|PT-EVAL^PT Evaluation|202606050930|||60|min",
      "AIL|1|A|CLINIC-D",
    ].join("\r"),
  );

  expect(appointment.start).toBe("2026-06-05T09:30:00Z");
  expect(appointment.minutesDuration).toBe(60);
  expect(appointment.end).toBe("2026-06-05T10:30:00Z");
});

test("the SIU shape utils/hl7v2-simulator emits maps end to end", async () => {
  // Mirrors buildSiu in utils/hl7v2-simulator: SCH-11 as ^^^<start>^<end>, no
  // AIL/AIP, one AIS. Kept in step with the generator so simulated traffic that
  // reaches this mapper is known to convert.
  const resources = await convert(
    [
      "MSH|^~\\&|SIM|SIMFAC|INTERBOX|HOSP|20260601120000||SIU^S12|SIM-1|P|2.5.1",
      "SCH|PLC-SIM-1|FIL-SIM-1|||||Routine||30|MIN|^^^202606081300^202606081330||||||DOC^Who^Bob",
      "PID|1||PT-SIM-1^^^SIMFAC^MR||Sim^Pat||19800101|M",
      "RGS|1|A",
      "AIS|1|A|PLC-SIM-1^Consult",
    ].join("\r"),
  );

  const appointment = pick<Appointment>(resources, "Appointment")[0]!;
  expect(appointment.id).toBe("simfac-fil-sim-1");
  expect(appointment.status).toBe("booked");
  expect(appointment.start).toBe("2026-06-08T13:00:00Z");
  expect(appointment.end).toBe("2026-06-08T13:30:00Z");
  expect(appointment.minutesDuration).toBe(30);
  expect(appointment.reasonCode?.[0]?.coding?.[0]?.code).toBe("Routine");
  expect(appointment.serviceType?.[0]?.coding?.[0]?.display).toBe("Consult");
  expect(appointment.participant.map((p) => p.actor?.reference)).toEqual([
    "Patient/simfac-pt-sim-1",
  ]);
});

test("unmappable SIU messages fail with a domain error naming what is missing", async () => {
  const header = "MSH|^~\\&|SCHED|HC|||20260601120000||SIU^S12^SIU_S12|MSG7|P|2.5";

  // domainError puts "<group>/<kind>" on the error rather than in the message.
  const kindOf = async (raw: string): Promise<string> => {
    try {
      await convert(raw);
    } catch (error) {
      return (error as { kind?: string }).kind ?? "";
    }
    throw new Error("expected the conversion to fail");
  };

  // No SCH at all.
  expect(await kindOf([header, "PID|1||PT-7^^^HC^MR"].join("\r"))).toBe("structure/missing_sch");

  // SCH with neither a placer nor a filler appointment id.
  expect(await kindOf([header, "SCH||||||BOOK", "PID|1||PT-7^^^HC^MR"].join("\r"))).toBe(
    "field/missing_appointment_id",
  );

  // Nothing to participate: no PID, no AIL, no AIP.
  expect(
    await kindOf([header, "SCH|PLC-7|FIL-7", "RGS|1|A", "AIS|1|A|SVC^Service"].join("\r")),
  ).toBe("structure/missing_appointment_participant");

  // A trigger event outside the mapped set, with no SCH-25 to fall back on.
  expect(
    await kindOf(
      [
        header.replace("SIU^S12^SIU_S12", "SIU^S99^SIU_S12"),
        "SCH|PLC-7|FIL-7",
        "PID|1||PT-7^^^HC^MR",
      ].join("\r"),
    ),
  ).toBe("field/unknown_appointment_status");
});
