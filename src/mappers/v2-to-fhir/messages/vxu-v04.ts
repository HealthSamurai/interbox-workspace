/**
 * HL7v2 VXU_V04 (Unsolicited Vaccination Record Update) → FHIR.
 *
 * Creates:
 * - Patient from PID
 * - Immunization[] — one per RXA. Each ORDER group is ORC, RXA, RXR[], OBX[];
 *   the Immunization.id is scoped to ORC-3 (filler order number) so a re-sent
 *   VXU for the same administration upserts in Aidbox instead of duplicating.
 *
 * ponytail: maps the clinically essential immunization fields (vaccineCode,
 * status, occurrence, dose, lot, expiration, route, site). Skipped — add when a
 * consumer needs it: manufacturer (RXA-17) and performer (RXA-10) each need an
 * emitted Organization/Practitioner + reference; OBX-derived funding/VIS data
 * maps to Immunization.programEligibility / education.
 */

import type { HL7v2Segment } from "@healthsamurai/interbox/hl7v2";
import {
  fromORC,
  fromPID,
  fromRXA,
  fromRXR,
  type RXA,
} from "@healthsamurai/interbox/hl7v2";
import type {
  DomainResource,
  Immunization,
  Reference,
} from "@healthsamurai/interbox/fhir/4.0.1";
import { domainError } from "@healthsamurai/interbox";
import { requirePid } from "../support/segments.ts";
import { patientIdFromPid } from "../support/identity.ts";
import { toKebabCase } from "../support/string.ts";
import { convertDTMToDate, convertDTMToDateTime } from "../support/datetime.ts";
import { convertCEToCodeableConcept } from "../datatypes/ce-codeableconcept.ts";
import { convertCWEToCodeableConcept } from "../datatypes/cwe-codeableconcept.ts";
import { convertPIDToPatient } from "../segments/pid-patient.ts";

interface RXAGroup {
  orc?: HL7v2Segment;
  rxa: HL7v2Segment;
  rxrs: HL7v2Segment[];
}

/**
 * Split the message into vaccination groups. An ORC seen before an RXA belongs
 * to that RXA; RXR segments attach to the RXA they follow.
 */
function groupByRXA(segments: HL7v2Segment[]): RXAGroup[] {
  const groups: RXAGroup[] = [];
  let pendingOrc: HL7v2Segment | undefined;
  let current: RXAGroup | null = null;

  for (const seg of segments) {
    switch (seg.segment) {
      case "ORC":
        pendingOrc = seg;
        break;
      case "RXA":
        current = { orc: pendingOrc, rxa: seg, rxrs: [] };
        groups.push(current);
        pendingOrc = undefined;
        break;
      case "RXR":
        if (current) {current.rxrs.push(seg);}
        break;
    }
  }

  return groups;
}

// RXA-20 completion status → Immunization.status; default completed (CP/PA).
function immunizationStatus(rxa: RXA): Immunization["status"] {
  switch (rxa.$20_completionStatus) {
    case "RE": // refused
    case "NA": // not administered
      return "not-done";
    default: // CP complete, PA partial, or absent
      return "completed";
  }
}

function immunizationId(
  group: RXAGroup,
  patientId: string,
  index: number,
): string {
  const orc = group.orc ? fromORC(group.orc) : undefined;
  const orderNo =
    orc?.$3_fillerOrderNumber?.$1_value || orc?.$2_placerOrderNumber?.$1_value;
  return toKebabCase(orderNo || `${patientId}-imm-${index + 1}`);
}

function convertRXAGroup(
  group: RXAGroup,
  patientRef: Reference<"Patient">,
  patientId: string,
  index: number,
): Immunization {
  const rxa = fromRXA(group.rxa);

  const vaccineCode = convertCEToCodeableConcept(rxa.$5_administeredCode);
  if (!vaccineCode) {
    throw domainError(
      "field",
      "missing_vaccine_code",
      "RXA-5 (administered code) is required but missing",
    );
  }

  const immunization: Immunization = {
    resourceType: "Immunization",
    id: immunizationId(group, patientId, index),
    status: immunizationStatus(rxa),
    vaccineCode,
    patient: patientRef,
  };

  const occurrence = convertDTMToDateTime(rxa.$3_startAdministrationDateTime);
  if (occurrence) {immunization.occurrenceDateTime = occurrence;}

  // RXA-6 amount + RXA-7 unit (UCUM). "999" is the table's "unknown" sentinel.
  if (rxa.$6_administeredAmount && rxa.$6_administeredAmount !== "999") {
    const value = Number(rxa.$6_administeredAmount);
    if (!Number.isNaN(value)) {
      const unit = rxa.$7_administeredUnit;
      immunization.doseQuantity = {
        value,
        ...(unit?.$2_text && { unit: unit.$2_text }),
        ...(unit?.$1_code && { code: unit.$1_code }),
        ...(unit?.$3_system && { system: unit.$3_system }),
      };
    }
  }

  if (rxa.$15_lotNumber?.[0]) {immunization.lotNumber = rxa.$15_lotNumber[0];}
  const exp = convertDTMToDate(rxa.$16_expiration?.[0]);
  if (exp) {immunization.expirationDate = exp;}

  const rxr = group.rxrs[0];
  if (rxr) {
    const r = fromRXR(rxr);
    const route = convertCEToCodeableConcept(r.$1_route);
    if (route) {immunization.route = route;}
    const site = convertCWEToCodeableConcept(r.$2_administrationSite);
    if (site) {immunization.site = site;}
  }

  return immunization;
}

/**
 * Convert an HL7v2 VXU_V04 message to a flat array of FHIR resources.
 *
 * Message Structure (subset mapped):
 * MSH - Message Header (1)
 * PID - Patient Identification (1) - required
 * { [ORC] - Common Order (0..1)
 *   RXA - Pharmacy Administration (1)
 *   [RXR] - Pharmacy Route (0..1)
 *   [OBX ...] - Observation (0..*) - not mapped (see header)
 * }
 */
export function convertVXU_V04(parsed: HL7v2Segment[]): DomainResource[] {
  const pid = fromPID(requirePid(parsed));
  const patient = convertPIDToPatient(pid);
  const patientId = patientIdFromPid(pid);
  patient.id = patientId;
  const patientRef: Reference<"Patient"> = {
    reference: `Patient/${patientId}`,
  };

  const groups = groupByRXA(parsed);
  if (groups.length === 0) {
    throw domainError(
      "structure",
      "missing_rxa",
      "VXU_V04 has no RXA segment — no vaccination to record",
    );
  }

  const entries: DomainResource[] = [patient];
  groups.forEach((group, i) => {
    entries.push(convertRXAGroup(group, patientRef, patientId, i));
  });

  return entries;
}
