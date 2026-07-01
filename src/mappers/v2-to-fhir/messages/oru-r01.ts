/**
 * HL7v2 ORU_R01 Message to FHIR Converter
 *
 * ORU_R01 - Unsolicited Observation Result
 *
 * Creates:
 * - Patient from PID
 * - DiagnosticReport from OBR
 * - Observation[] from OBX[] (NTE notes attached to the preceding OBX)
 * - Specimen from SPM (or OBR-15 fallback)
 *
 * Encounter handling: when PV1-19 is present we build the Encounter from PV1
 * and emit it (deterministic id); DiagnosticReport/Observation reference it.
 * The aidbox sender upserts by id, so an ADT for the same visit still owns the
 * record. When PV1 is absent or has no visit number the encounter is simply
 * omitted (PV1 is optional for ORU).
 */

import type {
  HL7v2Message,
  HL7v2Segment,
} from "@healthsamurai/interbox/hl7v2";
import {
  fromMSH,
  fromNTE,
  fromOBR,
  fromPID,
  fromPV1,
  fromSPM,
  type OBR,
  type SPM,
} from "@healthsamurai/interbox/hl7v2";
import type {
  DiagnosticReport,
  DomainResource,
  Encounter,
  Observation,
  Reference,
  Specimen,
} from "@healthsamurai/interbox/fhir/4.0.1";
import { domainError } from "@healthsamurai/interbox";
import { findSegment, findAllSegments, requirePid } from "../support/segments.ts";
import { senderFromMsh } from "../support/msh.ts";
import { patientIdFromPid, encounterIdFromPv1 } from "../support/identity.ts";
import { convertDTMToDateTime } from "../support/datetime.ts";
import { fromOBX } from "../wrappers/obx.ts";
import { convertPIDToPatient } from "../segments/pid-patient.ts";
import { convertPV1ToEncounter } from "../segments/pv1-encounter.ts";
import {
  convertOBXToObservation,
  convertOBXToObservationResolving,
} from "../segments/obx-observation.ts";
import { convertOBRToDiagnosticReport } from "../segments/obr-diagnosticreport.ts";
import { convertNTEsToAnnotation } from "../segments/nte-annotation.ts";
import type { MapperContext } from "@healthsamurai/interbox";
import type { CodeMappingContext } from "../code-mapping/observation-code-resolver.ts";

interface OBRGroup {
  obr: HL7v2Segment;
  observations: Array<{
    obx: HL7v2Segment;
    ntes: HL7v2Segment[];
  }>;
  specimens: HL7v2Segment[];
}

/**
 * Group segments by OBR parent
 * Each OBR creates a group with its following OBX, NTE, and SPM segments
 */
function groupSegmentsByOBR(message: HL7v2Message): OBRGroup[] {
  const groups: OBRGroup[] = [];
  let currentGroup: OBRGroup | null = null;
  let currentObservation: { obx: HL7v2Segment; ntes: HL7v2Segment[] } | null =
    null;

  for (const segment of message) {
    switch (segment.segment) {
      case "OBR":
        // Start a new group
        if (currentObservation && currentGroup) {
          currentGroup.observations.push(currentObservation);
        }
        currentObservation = null;

        currentGroup = {
          obr: segment,
          observations: [],
          specimens: [],
        };
        groups.push(currentGroup);
        break;

      case "OBX":
        // Add previous observation to group
        if (currentObservation && currentGroup) {
          currentGroup.observations.push(currentObservation);
        }
        currentObservation = { obx: segment, ntes: [] };
        break;

      case "NTE":
        // Attach to current observation
        if (currentObservation) {
          currentObservation.ntes.push(segment);
        }
        break;

      case "SPM":
        // Attach to current group
        if (currentGroup) {
          currentGroup.specimens.push(segment);
        }
        break;
    }
  }

  // Don't forget the last observation
  if (currentObservation && currentGroup) {
    currentGroup.observations.push(currentObservation);
  }

  return groups;
}

/**
 * Convert SPM segment to FHIR Specimen
 */
function convertSPMToSpecimen(
  spm: SPM,
  orderNumber: string,
  index: number,
): Specimen {
  // Generate ID: {orderNumber}-specimen-{index}
  const id = `${orderNumber.toLowerCase()}-specimen-${index}`.replace(
    /[^a-z0-9-]/g,
    "-",
  );

  const specimen: Specimen = {
    resourceType: "Specimen",
    id,
  };

  // SPM-4: Specimen Type
  if (spm.$4_specimenType) {
    specimen.type = {
      coding: [
        {
          code: spm.$4_specimenType.$1_code,
          display: spm.$4_specimenType.$2_text,
        },
      ],
      text: spm.$4_specimenType.$2_text,
    };
  }

  // SPM-17: Specimen Collection Date/Time
  if (spm.$17_specimenCollection) {
    const collectionTime = spm.$17_specimenCollection;
    if (collectionTime.$1_start) {
      specimen.collection = {
        collectedDateTime: convertDTMToDateTime(collectionTime.$1_start),
      };
    }
  }

  // SPM-18: Specimen Received Date/Time
  if (spm.$18_specimenReceived) {
    specimen.receivedTime = convertDTMToDateTime(spm.$18_specimenReceived);
  }

  return specimen;
}

/**
 * Create Specimen from OBR-15 (fallback for older versions)
 */
function createSpecimenFromOBR15(
  obr: OBR,
  orderNumber: string,
): Specimen | undefined {
  if (!obr.$15_specimenSource) {return undefined;}

  const sps = obr.$15_specimenSource;
  const id = `${orderNumber.toLowerCase()}-specimen-obr15`.replace(
    /[^a-z0-9-]/g,
    "-",
  );

  const specimen: Specimen = {
    resourceType: "Specimen",
    id,
  };

  // SPS.1: Specimen Source Name
  if (sps.$1_specimen) {
    specimen.type = {
      coding: [
        {
          code: sps.$1_specimen.$1_code,
          display: sps.$1_specimen.$2_text,
        },
      ],
      text: sps.$1_specimen.$2_text,
    };
  }

  return specimen;
}

function validateOBRPresence(message: HL7v2Message): void {
  const obrSegments = findAllSegments(message, "OBR");
  if (obrSegments.length === 0) {
    throw domainError(
      "structure",
      "missing_obr",
      "OBR segment not found in ORU_R01 message",
    );
  }
}

function getOrderNumber(obr: OBR): string {
  // Prefer OBR-3 (Filler Order Number), fallback to OBR-2 (Placer Order Number)
  const fillerOrderNumber = obr.$3_fillerOrderNumber?.$1_value;
  if (fillerOrderNumber) {
    return fillerOrderNumber;
  }

  const placerOrderNumber = obr.$2_placerOrderNumber?.$1_value;
  if (placerOrderNumber) {
    return placerOrderNumber;
  }

  throw domainError(
    "field",
    "missing_order_number",
    "Both OBR-3.1 (filler order number) and OBR-2.1 (placer order number) are empty",
  );
}

async function processObservations(
  observationGroups: OBRGroup["observations"],
  orderNumber: string,
  ctx?: CodeMappingContext,
): Promise<Observation[]> {
  const observations: Observation[] = [];

  for (const obsGroup of observationGroups) {
    const obx = fromOBX(obsGroup.obx);
    // With a code-mapping context resolve OBX-3 → LOINC; without one (offline
    // tests) keep the raw passthrough.
    const observation = ctx
      ? await convertOBXToObservationResolving(obx, orderNumber, ctx)
      : convertOBXToObservation(obx, orderNumber);

    if (obsGroup.ntes.length > 0) {
      const ntes = obsGroup.ntes.map((seg) => fromNTE(seg));
      const annotation = convertNTEsToAnnotation(ntes);
      if (annotation) {
        observation.note = [annotation];
      }
    }

    observations.push(observation);
  }

  return observations;
}

function processSpecimens(
  specimenSegments: HL7v2Segment[],
  obr: OBR,
  orderNumber: string,
): Specimen[] {
  const specimens: Specimen[] = [];

  if (specimenSegments.length > 0) {
    for (const [index, segment] of specimenSegments.entries()) {
      const spm = fromSPM(segment);
      specimens.push(convertSPMToSpecimen(spm, orderNumber, index + 1));
    }
  } else {
    const specimen = createSpecimenFromOBR15(obr, orderNumber);
    if (specimen) {
      specimens.push(specimen);
    }
  }

  return specimens;
}

function linkSpecimensToResources(
  specimens: Specimen[],
  diagnosticReport: DiagnosticReport,
  observations: Observation[],
): void {
  const firstSpecimen = specimens[0];
  if (!firstSpecimen) {return;}

  diagnosticReport.specimen = specimens.map(
    (s) => ({ reference: `Specimen/${s.id}` }) as Reference<"Specimen">,
  );

  const firstSpecimenRef = {
    reference: `Specimen/${firstSpecimen.id}`,
  } as Reference<"Specimen">;

  for (const obs of observations) {
    obs.specimen = firstSpecimenRef;
  }
}

/**
 * Link patient reference to all resources in an OBR group.
 */
function linkPatientToResources(
  patientRef: Reference<"Patient">,
  diagnosticReport: DiagnosticReport,
  observations: Observation[],
  specimens: Specimen[],
): void {
  diagnosticReport.subject = patientRef;

  for (const obs of observations) {
    obs.subject = patientRef;
  }

  for (const spec of specimens) {
    spec.subject = patientRef;
  }
}

/**
 * Link encounter reference to DiagnosticReport and Observations.
 * Specimen does not have an encounter field in FHIR R4.
 */
function linkEncounterToResources(
  encounterRef: Reference<"Encounter"> | null,
  diagnosticReport: DiagnosticReport,
  observations: Observation[],
): void {
  if (!encounterRef) {return;}

  diagnosticReport.encounter = encounterRef;

  for (const obs of observations) {
    obs.encounter = encounterRef;
  }
}

async function processOBRGroup(
  group: OBRGroup,
  patientRef: Reference<"Patient">,
  encounterRef: Reference<"Encounter"> | null,
  ctx?: CodeMappingContext,
): Promise<DomainResource[]> {
  const obr = fromOBR(group.obr);
  const orderNumber = getOrderNumber(obr);

  const diagnosticReport = convertOBRToDiagnosticReport(obr, orderNumber);

  const observations = await processObservations(group.observations, orderNumber, ctx);

  diagnosticReport.result = observations.map(
    (obs) =>
      ({ reference: `Observation/${obs.id}` }) as Reference<"Observation">,
  );

  const specimens = processSpecimens(group.specimens, obr, orderNumber);

  linkSpecimensToResources(specimens, diagnosticReport, observations);
  linkPatientToResources(patientRef, diagnosticReport, observations, specimens);
  linkEncounterToResources(encounterRef, diagnosticReport, observations);

  return [diagnosticReport, ...observations, ...specimens];
}

/**
 * Convert HL7v2 ORU_R01 message to a flat array of FHIR resources.
 *
 * Message Structure:
 * MSH - Message Header (1)
 * PID - Patient Identification (1) - required
 * PV1 - Patient Visit (0..1) - optional
 * { OBR - Observation Request (1)
 *   { OBX - Observation Result (0..*)
 *     NTE - Notes and Comments (0..*)
 *   }
 *   SPM - Specimen (0..*)
 * }
 */
export async function convertORU_R01(
  parsed: HL7v2Segment[],
  mapperCtx?: MapperContext,
): Promise<DomainResource[]> {
  const mshSegment = findSegment(parsed, "MSH");
  if (!mshSegment) {
    throw domainError(
      "field",
      "missing_sender",
      "MSH segment not found — sending application/facility unavailable",
    );
  }
  const sender = senderFromMsh(fromMSH(mshSegment));
  // Code-mapping context: only when terminology is supplied (live mapper run).
  // Absent in offline tests → OBX-3 keeps raw passthrough.
  const ctx: CodeMappingContext | undefined = mapperCtx
    ? { sender, translate: mapperCtx.translate }
    : undefined;

  validateOBRPresence(parsed);

  const pid = fromPID(requirePid(parsed));
  const patient = convertPIDToPatient(pid);
  patient.id = patientIdFromPid(pid);
  const patientRef: Reference<"Patient"> = {
    reference: `Patient/${patient.id}`,
  };

  // PV1 is optional for ORU; no PV1-19 → no encounter (not an error). When
  // present, build and emit the Encounter from PV1 — the aidbox sender upserts
  // by id, so an ADT for the same visit still owns the record.
  let encounterRef: Reference<"Encounter"> | null = null;
  let encounter: Encounter | null = null;
  const pv1Segment = findSegment(parsed, "PV1");
  if (pv1Segment) {
    const pv1 = fromPV1(pv1Segment);
    const encounterId = encounterIdFromPv1(pv1, sender.sendingFacility);
    if (encounterId) {
      encounterRef = { reference: `Encounter/${encounterId}` };
      encounter = convertPV1ToEncounter(pv1);
      encounter.id = encounterId;
      encounter.subject = patientRef as Encounter["subject"];
    }
  }

  const obrGroups = groupSegmentsByOBR(parsed);

  const entries: DomainResource[] = [patient];
  if (encounter) {entries.push(encounter);}
  for (const group of obrGroups) {
    entries.push(...(await processOBRGroup(group, patientRef, encounterRef, ctx)));
  }

  return entries;
}
