/**
 * The CDA header — who the document is about, what it is, and when.
 *
 * Only elements that are direct children of ClinicalDocument count. `<id>`,
 * `<code>` and `<effectiveTime>` recur at every level of a CDA, so a scan that
 * takes the first one it sees reports an author's timestamp as the document's
 * date. Depth is tracked and everything below the top level is skipped.
 *
 * Reading stops once the header is behind us, which is why a 12 MB document
 * costs the same as a 3 KB one: the caller hands in the first slice of the file
 * and nothing walks the clinical body.
 */

import { XmlCursor, readTextContent, skipElement } from "../xml/scan.ts";

export interface CdaHeader {
  /** ClinicalDocument/title, or the document type's display name. */
  title: string | null;
  /** LOINC code for the document type. */
  typeCode: string | null;
  /** ClinicalDocument/id as `root^extension`. */
  documentId: string | null;
  /** ClinicalDocument/effectiveTime, as written (`20260531101500-0500`). */
  effectiveTime: string | null;
  patientName: string | null;
  /** patientRole/id/@extension — the medical record number. */
  mrn: string | null;
  birthTime: string | null;
  /** `male` / `female` / the raw code when it is not one of those. */
  sex: string | null;
  /** The organization that holds the document. */
  custodian: string | null;
  /** False when the payload is not a CDA at all. */
  isClinicalDocument: boolean;
}

const EMPTY_HEADER: CdaHeader = {
  title: null, typeCode: null, documentId: null, effectiveTime: null,
  patientName: null, mrn: null, birthTime: null, sex: null,
  custodian: null, isClinicalDocument: false,
};

const SEX_BY_CODE: Readonly<Record<string, string>> = Object.freeze({
  M: "male", F: "female", UN: "undifferentiated",
});

/** `root^extension`, or whichever half is present. */
const joinId = (root?: string, extension?: string): string | null => {
  if (root && extension) return `${root}^${extension}`;
  return root ?? extension ?? null;
};

/**
 * A person's name from a CDA `<name>` element.
 *
 * Read part by part rather than as flattened text: `<given>Ada</given>
 * <family>Lovelace</family>` carries no whitespace of its own in most vendor
 * output, and flattening it yields `AdaLovelace`.
 */
function readName(cur: XmlCursor): string | null {
  const given: string[] = [];
  let family = "";
  let suffix = "";
  let depth = 1;
  for (let t = cur.next(); t !== null; t = cur.next()) {
    if (t.kind === "close" && t.local === "name" && --depth === 0) break;
    if (t.kind !== "open" || t.selfClose) continue;
    if (t.local === "name") { depth += 1; continue; }
    if (t.local === "given") given.push(readTextContent(cur, "given"));
    else if (t.local === "family") family = readTextContent(cur, "family");
    else if (t.local === "suffix") suffix = readTextContent(cur, "suffix");
    else skipElement(cur, t.local);
  }
  const full = [...given, family].filter(Boolean).join(" ").trim();
  const withSuffix = suffix ? `${full} ${suffix}`.trim() : full;
  return withSuffix === "" ? null : withSuffix;
}

/**
 * Read the subject of the document out of `<recordTarget>`.
 *
 * The cursor enters just past `<recordTarget>`, so the element that bounds this
 * read is recordTarget — `<patientRole>` and `<patient>` are levels to descend
 * through, not the exit condition.
 */
function readRecordTarget(cur: XmlCursor, into: { mrn: string | null; patientName: string | null; birthTime: string | null; sex: string | null }): void {
  let depth = 1;
  for (let t = cur.next(); t !== null; t = cur.next()) {
    if (t.kind === "close" && t.local === "recordTarget" && --depth === 0) return;
    if (t.kind !== "open") continue;
    if (t.local === "recordTarget") { if (!t.selfClose) depth += 1; continue; }

    switch (t.local) {
      case "patientRole":
      case "patient":
        break; // Levels to descend through; their children are read below.

      // The first identifier on the role is the MRN in every vendor export in
      // the corpus; later ones are payer and internal ids.
      case "id":
        into.mrn ??= t.attrs.extension ?? null;
        break;
      case "name":
        if (t.selfClose) break;
        into.patientName ??= readName(cur);
        break;
      case "birthTime":
        into.birthTime ??= t.attrs.value ?? null;
        break;
      case "administrativeGenderCode": {
        const code = t.attrs.code;
        if (code) into.sex ??= SEX_BY_CODE[code] ?? code;
        break;
      }
      default:
        if (!t.selfClose) skipElement(cur, t.local);
    }
  }
}

function readCustodianName(cur: XmlCursor): string | null {
  let found: string | null = null;
  let depth = 1;
  for (let t = cur.next(); t !== null; t = cur.next()) {
    if (t.kind === "close" && t.local === "custodian" && --depth === 0) break;
    if (t.kind !== "open" || t.selfClose) continue;
    if (t.local === "custodian") { depth += 1; continue; }
    if (t.local === "name") found ??= readTextContent(cur, "name");
  }
  return found;
}

/**
 * Parse the CDA header out of `xml`.
 *
 * `xml` may be a prefix of the document — the caller is expected to hand in the
 * first tens of kilobytes rather than the whole file. A truncated slice yields
 * whatever fields were inside it, with the rest null.
 */
export function parseHeader(xml: string): CdaHeader {
  const cur = new XmlCursor(xml);
  const out: CdaHeader = { ...EMPTY_HEADER };

  // Walk to <ClinicalDocument>. Anything else on the way is a declaration or a
  // comment; the first real element decides whether this is a CDA at all.
  let opened = false;
  for (let t = cur.next(); t !== null; t = cur.next()) {
    if (t.kind !== "open") continue;
    if (t.local !== "ClinicalDocument") return out;
    opened = true;
    break;
  }
  if (!opened) return out;
  out.isClinicalDocument = true;

  for (let t = cur.next(); t !== null; t = cur.next()) {
    if (t.kind === "close" && t.local === "ClinicalDocument") break;
    if (t.kind !== "open") continue;

    // The clinical body — everything the header has to offer is already behind
    // us, and this is where the other 99% of a large document lives.
    if (t.local === "component" || t.local === "documentationOf") break;

    if (t.selfClose) {
      switch (t.local) {
        case "id": out.documentId ??= joinId(t.attrs.root, t.attrs.extension); break;
        case "code":
          out.typeCode ??= t.attrs.code ?? null;
          out.title ??= t.attrs.displayName ?? null;
          break;
        case "effectiveTime": out.effectiveTime ??= t.attrs.value ?? null; break;
      }
      continue;
    }

    switch (t.local) {
      case "id": out.documentId ??= joinId(t.attrs.root, t.attrs.extension); skipElement(cur, "id"); break;
      case "code":
        out.typeCode ??= t.attrs.code ?? null;
        out.title ??= t.attrs.displayName ?? null;
        skipElement(cur, "code");
        break;
      case "effectiveTime": out.effectiveTime ??= t.attrs.value ?? null; skipElement(cur, "effectiveTime"); break;
      // A written title outranks the code's display name, which is why this
      // assigns rather than defaults.
      case "title": { const v = readTextContent(cur, "title"); if (v) out.title = v; break; }
      case "recordTarget": readRecordTarget(cur, out); break;
      case "custodian": out.custodian ??= readCustodianName(cur); break;
      default: skipElement(cur, t.local);
    }
  }

  return out;
}

/**
 * Render an HL7 timestamp (`20260531101500-0500`) as `2026-05-31 10:15`.
 *
 * The local time is shown as the document wrote it. Converting to the reader's
 * zone would move a clinical timestamp by hours, and a C-CDA's times belong to
 * the site that produced it.
 */
export function formatHl7Time(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, min] = m;
  let out = y!;
  if (mo) out += `-${mo}`;
  if (d) out += `-${d}`;
  if (h && min) out += ` ${h}:${min}`;
  return out;
}
