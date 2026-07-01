/**
 * HL7v2 ADT_A03 Message to FHIR Converter
 * Based on: HL7 Message - FHIR R4_ ADT_A01 - Sheet1.csv (reused for A03)
 *
 * ADT_A03 - Discharge/End Visit
 *
 * Creates:
 * - Patient from PID
 * - Encounter from PV1 (status MUST be "finished")
 * - RelatedPerson[] from NK1[]
 * - Condition[] from DG1[]
 * - AllergyIntolerance[] from AL1[]
 * - Coverage[] from IN1[]
 *
 * Key difference from A01: Encounter.status = "finished" (unconditional), not derived from PV1-2.
 */

import type { HL7v2Segment } from "@health-samurai/interbox/hl7v2";
import {
  fromMSH,
  fromPID,
  fromPV1,
  fromPV2,
  fromNK1,
  fromDG1,
  fromAL1,
  fromIN1,
  type DG1,
  type AL1,
} from "@health-samurai/interbox/hl7v2";
import type {
  Encounter,
  RelatedPerson,
  Condition,
  AllergyIntolerance,
  Coverage,
  DomainResource,
} from "@health-samurai/interbox/fhir/4.0.1";
import { domainError } from "@health-samurai/interbox";
import { findSegment, findAllSegments, requirePid } from "../support/segments.ts";
import { senderFromMsh } from "../support/msh.ts";
import { patientIdFromPid, encounterIdFromPv1 } from "../support/identity.ts";
import { toKebabCase } from "../support/string.ts";
import { convertPIDToPatient } from "../segments/pid-patient.ts";
import { convertPV1ToEncounter } from "../segments/pv1-encounter.ts";
import { convertNK1ToRelatedPerson } from "../segments/nk1-relatedperson.ts";
import { convertDG1ToCondition } from "../segments/dg1-condition.ts";
import { convertAL1ToAllergyIntolerance } from "../segments/al1-allergyintolerance.ts";
import { convertIN1ToCoverage, generateCoverageId, hasValidPayorInfo } from "../segments/in1-coverage.ts";

// ============================================================================
// Helper Functions
// ============================================================================

function generateId(prefix: string, index: number, controlId?: string): string {
  const suffix = controlId ? `-${controlId}` : "";
  return `${prefix}-${index}${suffix}`;
}

function prepareDG1ForExtraction(segments: HL7v2Segment[]): HL7v2Segment[] {
  const grouped = new Map<
    string,
    { segment: HL7v2Segment; priority: number | null }[]
  >();

  for (const segment of segments) {
    const dg1 = fromDG1(segment);
    const priorityStr = dg1.$15_diagnosisPriority;
    const priority = priorityStr ? parseInt(priorityStr, 10) : null;
    const validPriority =
      priority && !isNaN(priority) && priority > 0 ? priority : null;

    const code = dg1.$3_diagnosisCodeDg1?.$1_code || "";
    const display =
      dg1.$3_diagnosisCodeDg1?.$2_text || dg1.$4_diagnosisDescription || "";
    const key = `${code}|${display}`;

    let bucket = grouped.get(key);
    if (!bucket) {
      bucket = [];
      grouped.set(key, bucket);
    }
    bucket.push({ segment, priority: validPriority });
  }

  const deduplicated: HL7v2Segment[] = [];
  for (const items of grouped.values()) {
    items.sort((a, b) => {
      if (a.priority === null && b.priority === null) {return 0;}
      if (a.priority === null) {return 1;}
      if (b.priority === null) {return -1;}
      return a.priority - b.priority;
    });

    const first = items[0];
    if (first) {deduplicated.push(first.segment);}
  }

  return deduplicated;
}

function generateConditionId(dg1: DG1, prefix: string): string {
  const conditionName =
    dg1.$4_diagnosisDescription ||
    dg1.$3_diagnosisCodeDg1?.$2_text ||
    dg1.$3_diagnosisCodeDg1?.$1_code ||
    "condition";

  const kebabName = toKebabCase(conditionName);
  return `${prefix}-${kebabName}`;
}

function generateAllergyId(al1: AL1, patientId: string | undefined): string {
  const prefix = patientId || "unknown";
  const allergen = al1.$3_allergenCodeMnemonicDescription;
  const allergenName = allergen?.$1_code ?? allergen?.$2_text ?? "";

  return `${prefix}-${toKebabCase(allergenName)}`;
}

function hasValidAllergenInfo(al1: AL1): boolean {
  return !!(
    al1.$3_allergenCodeMnemonicDescription?.$1_code ||
    al1.$3_allergenCodeMnemonicDescription?.$2_text
  );
}

// ============================================================================
// Main Converter Function
// ============================================================================

/**
 * Convert HL7v2 ADT_A03 message to FHIR resources
 *
 * Discharge/End Visit notification. Encounter status is unconditionally "finished".
 * Reuses ADT_A01 segment converters and structure.
 */
export function convertADT_A03(parsed: HL7v2Segment[]): DomainResource[] {
  // =========================================================================
  // Extract MSH
  // =========================================================================

  const mshSegment = findSegment(parsed, "MSH");
  if (!mshSegment) {
    throw domainError("parse", "missing_msh", "MSH segment not found in ADT_A03 message");
  }
  const msh = fromMSH(mshSegment);
  const messageControlId = msh.$10_messageControlId;
  const sender = senderFromMsh(msh);

  // =========================================================================
  // Extract PID -> Patient
  // =========================================================================

  const pid = fromPID(requirePid(parsed));
  const patient = convertPIDToPatient(pid);
  patient.id = patientIdFromPid(pid);

  const patientRef = `Patient/${patient.id}`;

  // =========================================================================
  // Extract PV1 -> Encounter (required for A03, status="finished")
  // =========================================================================

  const pv1Segment = findSegment(parsed, "PV1");
  if (!pv1Segment) {
    throw domainError(
      "structure",
      "missing_pv1",
      "PV1 segment is required for ADT_A03 but missing",
    );
  }

  const pv1 = fromPV1(pv1Segment);
  const encounter = convertPV1ToEncounter(pv1);

  const encounterId = encounterIdFromPv1(pv1, sender.sendingFacility);
  if (!encounterId) {
    throw domainError(
      "field",
      "missing_visit_number",
      "PV1-19 (Visit Number) value is required but missing",
    );
  }
  encounter.id = encounterId;
  encounter.subject = { reference: patientRef } as Encounter["subject"];

  // REQ-1: Override status to "finished" unconditionally for A03 discharge
  encounter.status = "finished";

  // Handle PV2 fields if present
  const pv2Segment = findSegment(parsed, "PV2");
  if (pv2Segment) {
    const pv2 = fromPV2(pv2Segment);

    // REQ-9: PV2-3 Admit Reason → Encounter.reasonCode
    if (pv2.$3_admitReason) {
      if (!encounter.reasonCode) {
        encounter.reasonCode = [];
      }
      encounter.reasonCode.push({
        coding: [
          {
            code: pv2.$3_admitReason.$1_code,
            display: pv2.$3_admitReason.$2_text,
          },
        ],
      });
    }

    // REQ-10: PV2-11 Actual Length of Inpatient Stay → Encounter.length
    if (pv2.$11_actualLengthOfInpatientStay) {
      const los = parseInt(pv2.$11_actualLengthOfInpatientStay, 10);
      if (!isNaN(los) && los > 0) {
        encounter.length = {
          value: los,
          unit: "days",
          system: "http://unitsofmeasure.org",
          code: "d",
        };
      }
    }

    // REQ-11: PV2-12 Visit Description → Encounter.text.div
    if (pv2.$12_visitDescription) {
      encounter.text = {
        status: "generated",
        div: pv2.$12_visitDescription,
      };
    }

    // REQ-12: PV2-25 Visit Priority Code → Encounter.priority
    if (pv2.$25_visitPriorityCode) {
      encounter.priority = {
        coding: [
          {
            code: pv2.$25_visitPriorityCode,
          },
        ],
      };
    }
  }

  const encounterRef = `Encounter/${encounterId}`;

  // =========================================================================
  // Extract NK1[] -> RelatedPerson[]
  // =========================================================================

  const relatedPersons: RelatedPerson[] = [];
  const nk1Segments = findAllSegments(parsed, "NK1");

  for (const [i, segment] of nk1Segments.entries()) {
    const nk1 = fromNK1(segment);
    const relatedPerson = convertNK1ToRelatedPerson(nk1) as RelatedPerson;
    relatedPerson.patient = {
      reference: patientRef,
    } as RelatedPerson["patient"];
    relatedPerson.id = generateId("related-person", i + 1, messageControlId);
    relatedPersons.push(relatedPerson);
  }

  // =========================================================================
  // Extract DG1[] -> Condition[] (with deduplication)
  // =========================================================================

  const conditions: Condition[] = [];
  const dg1Segments = findAllSegments(parsed, "DG1");
  const deduplicatedDG1 = prepareDG1ForExtraction(dg1Segments);

  for (const dg1Segment of deduplicatedDG1) {
    const dg1 = fromDG1(dg1Segment);
    const condition = convertDG1ToCondition(dg1) as Condition;
    condition.subject = { reference: patientRef } as Condition["subject"];
    condition.encounter = {
      reference: encounterRef,
    } as Condition["encounter"];

    condition.id = generateConditionId(dg1, encounterId);
    conditions.push(condition);
  }

  // =========================================================================
  // Extract AL1[] -> AllergyIntolerance[] (with filtering)
  // =========================================================================

  const allergies: AllergyIntolerance[] = [];
  const al1Segments = findAllSegments(parsed, "AL1");

  for (const al1Segment of al1Segments) {
    const al1 = fromAL1(al1Segment);

    if (!hasValidAllergenInfo(al1)) {
      continue;
    }

    const allergy = convertAL1ToAllergyIntolerance(al1) as AllergyIntolerance;
    allergy.patient = {
      reference: patientRef,
    } as AllergyIntolerance["patient"];
    allergy.encounter = {
      reference: encounterRef,
    } as AllergyIntolerance["encounter"];

    allergy.id = generateAllergyId(al1, patient.id);
    allergies.push(allergy);
  }

  // =========================================================================
  // Extract IN1[] -> Coverage[] (with filtering)
  // =========================================================================

  const coverages: Coverage[] = [];
  const in1Segments = findAllSegments(parsed, "IN1");

  for (const in1Segment of in1Segments) {
    const in1 = fromIN1(in1Segment);

    if (!hasValidPayorInfo(in1)) {
      continue;
    }

    const coverage = convertIN1ToCoverage(in1) as Coverage;
    coverage.beneficiary = { reference: patientRef } as Coverage["beneficiary"];
    coverage.id = generateCoverageId(in1, patient.id);
    coverages.push(coverage);
  }

  // =========================================================================
  // Collect Entries
  // =========================================================================

  const entries: DomainResource[] = [patient, encounter];
  entries.push(...relatedPersons, ...conditions, ...allergies, ...coverages);

  return entries;
}
