/**
 * HL7v2 ADT_A01 Message to FHIR Converter
 * Based on: HL7 Message - FHIR R4_ ADT_A01 - Sheet1.csv
 *
 * ADT_A01 - Admit/Visit Notification
 *
 * Creates:
 * - Patient from PID
 * - Encounter from PV1
 * - RelatedPerson[] from NK1[]
 * - Condition[] from DG1[]
 * - AllergyIntolerance[] from AL1[]
 * - Coverage[] from IN1[]
 */

import type { HL7v2Segment } from "@health-samurai/interbox/hl7v2";
import {
  fromMSH,
  fromPID,
  fromPV1,
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

/**
 * Generate a deterministic ID from segment data
 */
function generateId(prefix: string, index: number, controlId?: string): string {
  const suffix = controlId ? `-${controlId}` : "";
  return `${prefix}-${index}${suffix}`;
}

/**
 * Deduplicate DG1 segments by diagnosis code+display
 * When duplicates exist, keep the one with lowest priority (1 < 2 < 3...)
 * Null priorities are ranked last
 */
function prepareDG1ForExtraction(segments: HL7v2Segment[]): HL7v2Segment[] {
  // Group segments by diagnosis key (code|display)
  const grouped = new Map<
    string,
    { segment: HL7v2Segment; priority: number | null }[]
  >();

  for (const segment of segments) {
    const dg1 = fromDG1(segment);

    // Parse priority from DG1.15
    const priorityStr = dg1.$15_diagnosisPriority;
    const priority = priorityStr ? parseInt(priorityStr, 10) : null;
    const validPriority =
      priority && !isNaN(priority) && priority > 0 ? priority : null;

    // Generate diagnosis key from code + display (or description)
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

  // For each group, select the one with lowest priority
  const deduplicated: HL7v2Segment[] = [];
  for (const items of grouped.values()) {
    // Sort by priority: null last, then ascending (1 < 2 < 3)
    items.sort((a, b) => {
      if (a.priority === null && b.priority === null) {return 0;}
      if (a.priority === null) {return 1;} // null ranks last
      if (b.priority === null) {return -1;}
      return a.priority - b.priority; // ascending
    });

    const first = items[0];
    if (first) {deduplicated.push(first.segment);}
  }

  return deduplicated;
}

/**
 * Generate composite condition ID
 * Format: {prefix}-{kebab-case-name}
 * Prefix is encounter.id when available, falls back to patient.id
 */
function generateConditionId(dg1: DG1, prefix: string): string {
  // Extract condition name (prefer description, then display, then code)
  const conditionName =
    dg1.$4_diagnosisDescription ||
    dg1.$3_diagnosisCodeDg1?.$2_text ||
    dg1.$3_diagnosisCodeDg1?.$1_code ||
    "condition";

  const kebabName = toKebabCase(conditionName);
  return `${prefix}-${kebabName}`;
}

/**
 * Generate composite allergy ID
 * Format: {patientId}-{kebab-case-allergen-name}
 * Patient ID is mandatory for ADT_A01
 */
function generateAllergyId(al1: AL1, patientId: string | undefined): string {
  const prefix = patientId || "unknown";

  // Extract allergen name from AL1.3 (guaranteed to exist by hasValidAllergenInfo filter)
  const allergen = al1.$3_allergenCodeMnemonicDescription;
  const allergenName = allergen?.$1_code ?? allergen?.$2_text ?? "";

  return `${prefix}-${toKebabCase(allergenName)}`;
}

/**
 * Check if AL1 segment has valid allergen information
 * AL1.3 (Allergen Code/Mnemonic/Description) is required per HL7v2 spec
 */
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
 * Convert HL7v2 ADT_A01 message to FHIR resources
 *
 * Message Structure:
 * MSH - Message Header (1)
 * EVN - Event Type (1)
 * PID - Patient Identification (1)
 * PV1 - Patient Visit (1)
 * NK1 - Next of Kin (0..*)
 * DG1 - Diagnosis (0..*)
 * AL1 - Allergy Information (0..*)
 * IN1 - Insurance (0..*)
 */
export function convertADT_A01(parsed: HL7v2Segment[]): DomainResource[] {
  // =========================================================================
  // Extract MSH
  // =========================================================================

  const mshSegment = findSegment(parsed, "MSH");
  if (!mshSegment) {
    throw domainError("parse", "missing_msh", "MSH segment not found in ADT_A01 message");
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
  // Extract PV1 -> Encounter (required for A01)
  // =========================================================================

  const pv1Segment = findSegment(parsed, "PV1");
  if (!pv1Segment) {
    throw domainError(
      "structure",
      "missing_pv1",
      "PV1 segment is required for ADT_A01 but missing",
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

  // Deduplicate by diagnosis code+display, keeping lowest priority
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

    // Skip AL1 segments without valid allergen information
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

    // Generate composite ID
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

    // Skip IN1 segments without valid payor information
    if (!hasValidPayorInfo(in1)) {
      continue;
    }

    const coverage = convertIN1ToCoverage(in1) as Coverage;
    coverage.beneficiary = { reference: patientRef } as Coverage["beneficiary"];

    // Generate composite ID
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
