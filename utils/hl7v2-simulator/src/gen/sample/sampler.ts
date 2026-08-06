import type { Rng } from "../rng.ts";
import type { CategoricalDist, CodedModel, NumericModel, Weighted } from "../../profile/schema.ts";

/** Pick a value from a weighted distribution. */
export function sampleWeighted<T>(rng: Rng, dist: Weighted<T>): T {
  return rng.weighted(dist);
}

export function sampleCategorical(rng: Rng, field: CategoricalDist | undefined, fallback = ""): string {
  if (!field || field.dist.length === 0) return fallback;
  return rng.weighted(field.dist);
}

/** Standard-normal via Box-Muller, built on the project Rng (seedable, deterministic). */
export function gaussian(rng: Rng, mean: number, sd: number): number {
  // u in (0,1] to avoid log(0)
  const u1 = 1 - rng.next();
  const u2 = rng.next();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + sd * z;
}

export interface SampledValue {
  value: string; // formatted observation value
  flag: "" | "H" | "L"; // abnormal flag, derived from value vs reference range
}

function parseRef(ref: string): [number, number] | null {
  const m = ref.match(/^([\d.]+)\s*-\s*([\d.]+)$/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/**
 * Draw a numeric observation: gaussian, clamped to [min,max], 1-dp. With prob
 * `abnormalRate` the draw is pushed into a tail OUTSIDE the reference range so
 * abnormal results occur — and the H/L flag is derived from the actual value vs
 * the range, so flag and value never contradict.
 */
export function sampleNumeric(rng: Rng, m: NumericModel): SampledValue {
  const range = parseRef(m.ref);
  let raw: number;
  if (range && rng.next() < m.abnormalRate) {
    const [lo, hi] = range;
    raw = rng.next() < 0.5 ? lo - Math.abs(gaussian(rng, 0, m.sd)) - 0.1 : hi + Math.abs(gaussian(rng, 0, m.sd)) + 0.1;
  } else {
    raw = gaussian(rng, m.mean, m.sd);
  }
  raw = Math.max(m.min, Math.min(m.max, raw));
  const value = (Math.round(raw * 10) / 10).toString();
  let flag: "" | "H" | "L" = "";
  if (range) {
    const v = Number(value);
    if (v < range[0]) flag = "L";
    else if (v > range[1]) flag = "H";
  }
  return { value, flag };
}

export interface ResultValue {
  valueType: string; // OBX-2
  value: string; // OBX-5
  units: string; // OBX-6
  ref: string; // OBX-7
  flag: "" | "H" | "L" | "A"; // OBX-8
}

/** Sample a result from a numeric OR coded model into the OBX fields. */
export function sampleResult(rng: Rng, model: NumericModel | CodedModel): ResultValue {
  if (model.kind === "coded") {
    const value = rng.weighted(model.dist);
    const flag = /detect|positive|abnormal|reactive/i.test(value) && !/not |non-?reactive|negative/i.test(value) ? "A" : "";
    return { valueType: model.valueType, value, units: "", ref: "", flag };
  }
  const { value, flag } = sampleNumeric(rng, model);
  return { valueType: "NM", value, units: model.units, ref: model.ref, flag };
}

/**
 * Fill an id format: `#` -> digit, `@` -> uppercase letter, else literal.
 * `index` seeds uniqueness so minted ids never collide (and never dedup-collapse).
 */
export function fillFormat(rng: Rng, pattern: string, index: number): string {
  const hashCount = (pattern.match(/#/g) ?? []).length;
  const digits = String(index % 10 ** hashCount).padStart(hashCount, "0");
  let di = 0;
  let out = "";
  for (const ch of pattern) {
    if (ch === "#") out += digits[di++];
    else if (ch === "@") out += String.fromCharCode(65 + rng.int(26));
    else out += ch;
  }
  return out;
}
