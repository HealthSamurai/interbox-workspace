// The learned artifact. ONLY aggregate distributions — no raw records, no raw
// value lists, no free text.

/** A weighted choice list; weights need not sum to 1 (Rng.weighted normalizes). */
export type Weighted<T = string> = Array<[T, number]>;

/** Coded/categorical field: sampled by frequency. */
export interface CategoricalDist {
  kind: "categorical";
  dist: Weighted;
}

/** Numeric observation value: summary stats, never a raw value list (§3 rule 2). */
export interface NumericModel {
  kind: "numeric";
  units: string;
  ref: string; // reference range text, e.g. "136-145"
  mean: number;
  sd: number;
  min: number;
  max: number;
  abnormalRate: number; // P(result flagged abnormal)
}

/** A lab panel: which OBX codes ship together (| OBR code) + a value model each.
 *  The qualitative shape (specimen, per-code value type/units) is learned as a
 *  UNIT from the corpus and never recombined — the generator changes only the
 *  numbers. See the qualitative-panel-skeleton spec. */
export interface PanelModel {
  /** OBX-3 codes in order, e.g. "NA^SODIUM". */
  obx: string[];
  /** SPM-4 / OBR-15 specimen observed for this panel; absent when the corpus
   *  panel carried none — the generator then emits NO SPM (never a guess). */
  specimen?: string;
  /** code -> value model (numeric OR coded — the learned OBX-2 decides). */
  values: Record<string, NumericModel | CodedModel>;
}

/** A qualitative (non-numeric) result: a distribution over observed values. */
export interface CodedModel {
  kind: "coded";
  valueType: string; // OBX-2, e.g. "ST"
  dist: Weighted; // observed result values, e.g. [["Not Detected",..],["Detected",..]]
}

/**
 * One local-lab-code concept: a local proprietary code (obfuscated) and, when the
 * source carried it, the standard reference code (LOINC). The generator emits OBX
 * with the local triplet (the mapping *input*); `loinc` is the known answer.
 * See spec 2026-06-10_local-code-mapping-fixtures-spec.md §4.1.
 */
export interface CodeMapEntry {
  local: { code: string; system: string; text: string };
  loinc: { code: string; text: string; system: string } | null;
  value: NumericModel | CodedModel;
  /** Specimen observed on the message that carried this local code, if any —
   *  emitted as-is; never inferred. */
  specimen?: string;
  weight: number;
}

export interface ProfileCatalogs {
  /** Facility names (MSH-4), frequency-weighted. */
  facility: Weighted;
  /** PID-3 assigning authority codes. */
  assigningAuthority: Weighted;
  /** OBR producing-lab / LIS labels. */
  lis: Weighted;
  /** Provider entries as "id^family^given". */
  provider: Weighted;
  /** Sending/receiving application names (MSH-3/5). */
  app: Weighted;
}

export interface ProfileTemporal {
  /** Inclusive [from, to] year range for MSH-7 send time. */
  sendYearRange: [number, number];
  /** Minutes from collection (OBR) to result (OBX), gaussian. */
  collectToResultMins: { mean: number; sd: number };
}

/**
 * Format strings for synthetic identifiers. `#` -> a digit, `@` -> an uppercase
 * letter; any other char is literal. IDs are never learned as values (§3 rule 4),
 * only their shape — minted unique at generation so dedup never collapses them.
 */
export interface ProfileIdFormats {
  mrn: string;
  controlId: string;
  placer: string;
  filler: string;
  visit: string;
}

export interface Profile {
  version: number;
  minSupport: number;
  /** "ORU^R01" -> weight. */
  messageTypes: Weighted;
  /** type -> repetition-name -> distribution over counts. */
  segmentReps: Record<string, Record<string, Weighted<number>>>;
  /** "PID-8" -> categorical dist. */
  fields: Record<string, CategoricalDist>;
  /** OBR order-code -> panel; `panelMix` picks which order to emit. */
  panels: Record<string, PanelModel>;
  /** "10054^BASIC METABOLIC PANEL^LAB" -> weight. */
  panelMix: Weighted;
  catalogs: ProfileCatalogs;
  temporal: ProfileTemporal;
  idFormats: ProfileIdFormats;
  /** Local-lab-code concepts for the code-mapping showcase (optional). */
  codeMap?: CodeMapEntry[];
  /** Fraction of ORU that draw OBX from `codeMap` (local codes) vs standard panels. 0 = off. */
  localCodeRate?: number;
  /** Of local-code ORU, fraction emitted dual-coded (local+LOINC reference) vs local-only (unmapped input). */
  mappedRate?: number;
}

export const PROFILE_VERSION = 1;

/** Parse + minimally validate a profile.json. Throws on shape/version mismatch. */
export function parseProfile(text: string): Profile {
  const p = JSON.parse(text) as Profile;
  if (p.version !== PROFILE_VERSION) {
    throw new Error(`profile version ${p.version} != supported ${PROFILE_VERSION}`);
  }
  if (!p.messageTypes?.length) throw new Error("profile has no messageTypes");
  return p;
}
