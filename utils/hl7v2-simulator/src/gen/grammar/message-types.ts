import type { Rng } from "../rng.ts";
import type { CodeMapEntry, Profile } from "../../profile/schema.ts";
import type { Identity } from "../sample/identity.ts";
import { sampleCategorical, sampleResult, sampleWeighted } from "../sample/sampler.ts";

export interface GenContext {
  rng: Rng;
  profile: Profile;
  id: Identity;
  index: number;
}

// Receiving side (MSH-5 / MSH-6) — the stand being fed, not something the
// corpus can tell us. Defaults to the Interbox engine; override when you point
// the simulator at an interface engine that routes on the receiver fields.
const RECEIVING_APP = process.env.RECEIVING_APP || "INTERBOX";
const RECEIVING_FACILITY = process.env.RECEIVING_FACILITY || "INTERBOX";

// ── shared segment builders ────────────────────────────────────────────────

function buildMsh(ctx: GenContext, type: string, event: string): string {
  const { rng, profile, id } = ctx;
  const app = sampleWeighted(rng, profile.catalogs.app);
  const fac = sampleWeighted(rng, profile.catalogs.facility);
  return `MSH|^~\\&|${app}|${fac}|${RECEIVING_APP}|${RECEIVING_FACILITY}|${id.sendTime}||${type}^${event}|${id.controlId}|P|2.5.1`;
}

function buildPid(ctx: GenContext): string {
  const { rng, profile, id } = ctx;
  const aa = sampleWeighted(rng, profile.catalogs.assigningAuthority);
  // PID-3 = MRN^^^assigningAuthority^MR ; PID-5 = family^given ; PID-7 = DOB ; PID-8 = sex
  return `PID|1||${id.mrn}^^^${aa}^MR||${id.family}^${id.given}||${id.dob}|${id.sex}`;
}

function buildPv1(ctx: GenContext): string {
  const { rng, profile, id } = ctx;
  const cls = sampleCategorical(rng, profile.fields["PV1-2"], "I");
  const provider = sampleWeighted(rng, profile.catalogs.provider);
  // PV1-2 patient class, PV1-7 attending provider, PV1-19 visit number. The
  // v2-to-FHIR IG keys the Encounter on PV1-19; without it ADT/ORU visit
  // conversion fails with missing_visit_number.
  return `PV1|1|${cls}|||||${provider}||||||||||||${id.visit}`;
}

// NTE — real vendor ORU carry note segments in the hundreds (methodology, specimen
// quality, critical-value callbacks); the original generator emitted none. Emitted
// AFTER an OBX so the mapper folds them into Observation.note (convertNTEsToAnnotation).
// English only (committed code). NTE-2 = "L" (filler/lab source).
const LAB_NOTES: readonly string[] = [
  "Result verified by repeat analysis.",
  "Specimen slightly hemolyzed; result may be affected.",
  "Reference range adjusted for patient age and sex.",
  "Performed by high-complexity method.",
  "Critical value phoned to ordering provider.",
  "Fasting specimen received.",
  "Test performed at reference laboratory.",
  "Result confirmed on dilution.",
];
const NTE_RATE = 0.3; // fraction of OBX that carry a note (approx. real ORU comment density)

// ── per-type builders (segment list; event-parameterized) ───────────────────

function buildOru(ctx: GenContext, event: string): string[] {
  const { rng, profile, id } = ctx;
  const provider = sampleWeighted(rng, profile.catalogs.provider);
  const segs = [buildMsh(ctx, "ORU", event), buildPid(ctx), buildPv1(ctx)];

  // Code-mapping showcase: OBX carry LOCAL lab codes (the mapping input). With
  // prob mappedRate the LOINC triplet is included (reference/answer present);
  // otherwise it's local-only (unmapped — the AI feature must resolve it).
  const codeMap = profile.codeMap;
  if (codeMap && codeMap.length > 0 && rng.next() < (profile.localCodeRate ?? 0)) {
    const mappedRate = profile.mappedRate ?? 0.5;
    const pick = (): CodeMapEntry => sampleWeighted(rng, codeMap.map((e) => [e, e.weight] as [CodeMapEntry, number]));
    const picks = Array.from({ length: 1 + rng.int(Math.min(5, codeMap.length)) }, pick);
    const order = picks[0]!;
    segs.push(`ORC|RE|${id.placer}|${id.filler}|||||||||${provider}`);
    segs.push(`OBR|1|${id.placer}|${id.filler}|${order.local.code}^${order.local.text}^${order.local.system}|||${id.collectTime}|||||||${id.collectTime}||${provider}|||||${id.sendTime}|||F`);
    segs.push(`TQ1|1||||||${id.collectTime}|${id.collectTime}|R`);
    picks.forEach((e, i) => {
      const r = sampleResult(rng, e.value);
      const dual = e.loinc && rng.next() < mappedRate;
      const code = dual
        ? `${e.local.code}^${e.local.text}^${e.local.system}^${e.loinc!.code}^${e.loinc!.text}^${e.loinc!.system}`
        : `${e.local.code}^${e.local.text}^${e.local.system}`;
      segs.push(`OBX|${i + 1}|${r.valueType}|${code}||${r.value}|${r.units}|${r.ref}|${r.flag}|||F|||${id.sendTime}`);
      if (rng.next() < NTE_RATE) {segs.push(`NTE|1|L|${rng.pick(LAB_NOTES)}`);}
    });
    // Specimen from the order's learned code (never inferred); absent → no SPM.
    if (order.specimen) segs.push(`SPM|1|||${order.specimen}`);
    return segs;
  }

  // Standard panel path.
  const panelCode = sampleWeighted(rng, profile.panelMix);
  const panel = profile.panels[panelCode];
  const lis = sampleWeighted(rng, profile.catalogs.lis);
  segs.push(`ORC|RE|${id.placer}|${id.filler}|||||||||${provider}`);
  segs.push(
    `OBR|1|${id.placer}|${id.filler}|${panelCode}|||${id.collectTime}|||||||${id.collectTime}||${provider}|||||${id.sendTime}|||F|||||${lis}`,
  );
  segs.push(`TQ1|1||||||${id.collectTime}|${id.collectTime}|R`);
  if (panel) {
    panel.obx.forEach((code, i) => {
      const model = panel.values[code];
      if (!model) return;
      // sampleResult handles both numeric and coded members — the learned OBX-2
      // decides; only the number varies, the qualitative fields are fixed.
      const r = sampleResult(rng, model);
      segs.push(`OBX|${i + 1}|${r.valueType}|${code}||${r.value}|${r.units}|${r.ref}|${r.flag}|||F|||${id.sendTime}`);
      if (rng.next() < NTE_RATE) {segs.push(`NTE|1|L|${rng.pick(LAB_NOTES)}`);}
    });
  }
  // SPM only when the panel actually carried a specimen in the corpus (never guessed).
  if (panel?.specimen) segs.push(`SPM|1|||${panel.specimen}`);
  return segs;
}

function buildAdt(ctx: GenContext, event: string): string[] {
  const { id } = ctx;
  return [
    buildMsh(ctx, "ADT", event),
    `EVN|${event}|${id.sendTime}`,
    buildPid(ctx),
    buildPv1(ctx),
  ];
}

// ── corpus-coverage builders ────────────────────────────────────────────────
// Segment skeletons mirror real-world HL7v2 traffic; all values are synthetic.
// LOINC document-type codes are universal vocabulary, not PHI.

// Synthetic medication pool for RXE/RXA/RXC (local-coded, corpus-style ^L).
const MEDS: readonly [code: string, dose: string, unit: string, route: string, form: string][] = [
  ["NIT^nitroglycerin 0.4 MG SL tablet^L", "0.4", "MG", "SUBLINGUAL^Sublingual", "TAB.SUBL"],
  ["MET500^metFORMIN 500 MG oral tablet^L", "500", "MG", "PO^Oral", "TAB"],
  ["SOLU40^SOLU-Medrol 40 MG IVPUSH^L", "40", "MG", "IVPUSH^IVPUSH^L", "VIAL"],
  ["LISIN10^lisinopril 10 MG oral tablet^L", "10", "MG", "PO^Oral", "TAB"],
  ["CEFTRI1^cefTRIaxone 1 G IVPB^L", "1", "G", "IVPB^IV Piggyback^L", "VIAL"],
  ["AMLO5^amLODIPine 5 MG oral tablet^L", "5", "MG", "PO^Oral", "TAB"],
];

// LOINC document-type codes for TXA-2 (real vocabulary, synthetic content).
const DOC_TYPES: readonly [string, string][] = [
  ["34109-9", "Note"],
  ["18842-5", "Discharge Summary"],
  ["11506-3", "Progress Note"],
  ["34117-2", "History and Physical"],
  ["11488-4", "Consultation Note"],
];

const NOTE_LINES: readonly string[] = [
  "Patient seen and examined; findings discussed.",
  "Vital signs stable; afebrile throughout the stay.",
  "Imaging reviewed with radiology; no acute findings.",
  "Medication list reconciled at discharge.",
  "Follow-up with primary care in two weeks.",
  "Labs trending toward baseline; continue current plan.",
  "Patient tolerating oral intake without difficulty.",
];

// ORM^O01 — NEW lab order (the other half of the ORU pair: order out, result back).
function buildOrm(ctx: GenContext, event: string): string[] {
  const { rng, profile, id } = ctx;
  const provider = sampleWeighted(rng, profile.catalogs.provider);
  const panel = sampleWeighted(rng, profile.panelMix);
  return [
    buildMsh(ctx, "ORM", event),
    buildPid(ctx),
    buildPv1(ctx),
    `ORC|NW|${id.placer}|${id.filler}|||||||||${provider}`,
    `OBR|1|${id.placer}|${id.filler}|${panel}|||${id.collectTime}|||||||||${provider}`,
  ];
}

// MDM^T02/T07/T11 — document notification (+ content as OBX ST lines).
function buildMdm(ctx: GenContext, event: string): string[] {
  const { rng, profile, id } = ctx;
  const provider = sampleWeighted(rng, profile.catalogs.provider);
  const [docCode, docName] = DOC_TYPES[rng.int(DOC_TYPES.length)]!;
  const segs = [
    buildMsh(ctx, "MDM", event),
    `EVN|${event}|${id.sendTime}`,
    buildPid(ctx),
    buildPv1(ctx),
    // TXA-12 = Unique Document Number (TXA-10 is the authenticator). The IG keys
    // the DocumentReference id on TXA-12, so the doc number must live there for
    // T11 cancels to upsert the original rather than mint a new resource.
    `TXA|1|${docCode}^${docName}|TX|${id.sendTime}|${provider}|${id.sendTime}||||||${id.filler}||||AU`,
  ];
  const lines = 2 + rng.int(4);
  for (let i = 0; i < lines; i++) {
    segs.push(`OBX|${i + 1}|ST|||${NOTE_LINES[rng.int(NOTE_LINES.length)]}`);
  }
  return segs;
}

// RAS^O17 — pharmacy administration (given dose recorded).
function buildRas(ctx: GenContext, event: string): string[] {
  const { rng, profile, id } = ctx;
  const provider = sampleWeighted(rng, profile.catalogs.provider);
  const [med, dose, unit, route, form] = MEDS[rng.int(MEDS.length)]!;
  return [
    buildMsh(ctx, "RAS", event),
    buildPid(ctx),
    buildPv1(ctx),
    `ORC|RE|${id.placer}||||N|${dose}&${unit}^Q8H^^${id.collectTime}^^R|||${provider}`,
    `TQ1|1|${dose}^${unit}&${unit}&L|Q8H||||${id.collectTime}||R^Routine^L`,
    `RXE||${med}|${dose}||${unit}^${unit}^L|${form}^${form}^L`,
    `RXR|${route}`,
    `RXC|B|${med}|${dose}|${unit}^${unit}^L`,
    `RXA|0|1|${id.collectTime}|${id.collectTime}|${med}|${dose}|${unit}^${unit}^L||||||||||||CP`,
  ];
}

// RDE^O01/O11 — pharmacy encoded order (O01 is the legacy event, PV2 present).
function buildRde(ctx: GenContext, event: string): string[] {
  const { rng, profile, id } = ctx;
  const provider = sampleWeighted(rng, profile.catalogs.provider);
  const [med, dose, unit, route, form] = MEDS[rng.int(MEDS.length)]!;
  const segs = [buildMsh(ctx, "RDE", event), buildPid(ctx), buildPv1(ctx)];
  if (event === "O01") segs.push(`PV2|||^Medication order`);
  segs.push(`ORC|NW|${id.placer}|||||^Q8H^^${id.collectTime}^^R^1||${id.sendTime}|||${provider}`);
  segs.push(`RXE|^Q8H^^${id.collectTime}^^R|${med}|${dose}||${unit}^${unit}^L|${form}^${form}^L`);
  if (event !== "O01") {
    segs.push(`TQ1|1||Q8H||||${id.collectTime}||R^Routine^L`);
    segs.push(`RXR|${route}`);
  }
  return segs;
}

function buildSiu(ctx: GenContext, event: string): string[] {
  const { rng, profile, id } = ctx;
  const provider = sampleWeighted(rng, profile.catalogs.provider);
  // SCH-11 = ^^^<start>^<end> (engine reads appointment start/end positionally)
  return [
    buildMsh(ctx, "SIU", event),
    `SCH|${id.placer}|${id.filler}|||||Routine||30|MIN|^^^${id.collectTime}^${id.sendTime}||||||${provider}`,
    buildPid(ctx),
    `RGS|1|A`,
    `AIS|1|A|${id.placer}^Consult`,
  ];
}

export type MessageBuilder = (ctx: GenContext, event: string) => string[];

/** Registry keyed by message TYPE (event is parameterized) — extend here. */
export const BUILDERS: Record<string, MessageBuilder> = {
  ORU: buildOru,
  ADT: buildAdt,
  SIU: buildSiu,
  ORM: buildOrm,
  MDM: buildMdm,
  RAS: buildRas,
  RDE: buildRde,
};

/** Message types the generator can emit — the profiler restricts its mix to these. */
export const SUPPORTED_TYPES: ReadonlySet<string> = new Set(Object.keys(BUILDERS));
