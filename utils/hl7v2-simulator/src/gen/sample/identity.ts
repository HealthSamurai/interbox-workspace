import type { Rng } from "../rng.ts";
import type { NameProvider } from "../names.ts";
import type { Profile } from "../../profile/schema.ts";
import { fillFormat, gaussian, sampleCategorical } from "./sampler.ts";

export interface Identity {
  mrn: string;
  controlId: string;
  placer: string;
  filler: string;
  visit: string;
  family: string;
  given: string;
  sex: string; // PID-8
  dob: string; // YYYYMMDD
  sendTime: string; // YYYYMMDDHHMMSS (MSH-7, result time)
  collectTime: string; // YYYYMMDDHHMMSS (specimen collection, earlier)
}

const pad = (n: number, w: number) => String(n).padStart(w, "0");
const fmtDtm = (d: Date) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1, 2)}${pad(d.getUTCDate(), 2)}` +
  `${pad(d.getUTCHours(), 2)}${pad(d.getUTCMinutes(), 2)}${pad(d.getUTCSeconds(), 2)}`;

/**
 * All synthetic identity/time fields a message needs. `index` guarantees unique
 * identifiers (so the engine's dedup never collapses generated messages).
 *
 * `sendOverride` pins MSH-7 to a caller-supplied instant instead of sampling the
 * profile's year range — used by the sender CLI to spread MSH-7 over a recent
 * window (batch) or stamp live wall-clock time (stream). When omitted, the
 * year-range sampling path is byte-identical to before (same RNG draws).
 */
export function makeIdentity(rng: Rng, names: NameProvider, profile: Profile, index: number, sendOverride?: Date): Identity {
  const [from, to] = profile.temporal.sendYearRange;
  // `??` short-circuits: when sendOverride is set the RHS (and its 6 rng draws)
  // is skipped entirely, so the override path is deterministic on its own seed.
  const send = sendOverride ?? new Date(
    Date.UTC(from + rng.int(to - from + 1), rng.int(12), 1 + rng.int(28), rng.int(24), rng.int(60), rng.int(60)),
  );
  const offsetMin = Math.max(1, Math.round(gaussian(rng, profile.temporal.collectToResultMins.mean, profile.temporal.collectToResultMins.sd)));
  const collect = new Date(send.getTime() - offsetMin * 60_000);

  const dobYear = 1940 + rng.int(70);
  return {
    mrn: fillFormat(rng, profile.idFormats.mrn, index),
    controlId: fillFormat(rng, profile.idFormats.controlId, index),
    placer: fillFormat(rng, profile.idFormats.placer, index),
    filler: fillFormat(rng, profile.idFormats.filler, index),
    visit: fillFormat(rng, profile.idFormats.visit, index),
    family: names.lastName(),
    given: names.firstName(),
    sex: sampleCategorical(rng, profile.fields["PID-8"], "U"),
    dob: `${dobYear}${pad(1 + rng.int(12), 2)}${pad(1 + rng.int(28), 2)}`,
    sendTime: fmtDtm(send),
    collectTime: fmtDtm(collect),
  };
}
