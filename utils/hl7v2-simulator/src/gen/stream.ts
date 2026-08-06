// One generator, used by every caller that wants "a message, maybe broken".
//
// This block — draw a message, roll faultRate, pick a fault, apply it — used to
// exist in five places (the two CLIs, the UI's folder export, the UI's classic
// stream, and each SourceActor). They had drifted: the `src/` copies drew fault
// decisions from the seeded Rng, the `ui/` copies used Math.random(). So the
// documented "own seeded RNG" guarantee held for `bun run gen` and not for
// anything the UI drove — same seed, different faults, silently.
//
// Everything goes through here now, so the seed governs content AND faults.
import { generateMessage } from "./assemble.ts";
import { FAULTS } from "./faults.ts";
import { fakerNames } from "./names.ts";
import { Rng } from "./rng.ts";
import type { Profile } from "../profile/schema.ts";

export interface StreamMessage {
  msg: string;
  type: string;
  /** True when a fault was deliberately injected into this message. */
  injected: boolean;
}

export interface GeneratorOpts {
  profile: Profile;
  /** Seed for content, identities and fault selection alike. */
  seed: number;
  /**
   * Force an exact message-type mix, round-robin so every listed type appears
   * evenly regardless of the profile's own weights. Empty/omitted = profile mix.
   */
  types?: string[] | null;
  /**
   * Stamp MSH-7 with wall-clock time instead of sampling the profile's year
   * range. Live streams want "now"; corpus generation wants the profile.
   */
  liveTime?: boolean;
  /** Index to start identifiers at — lets a restart avoid replaying IDs. */
  startIndex?: number;
  locale?: "en" | "de";
}

/**
 * Build a generator: call the result with a fault rate to get one message.
 *
 * The optional `now` pins MSH-7 for that message — the sender CLI uses it to
 * spread a batch over a past window. Omitted, it falls back to wall-clock when
 * `liveTime` is set, and otherwise to the profile's own year range.
 *
 * The fault is rolled AFTER the message is built, so the RNG stream — and
 * therefore the content — is identical whether or not a fault lands. Only the
 * corruption differs.
 */
export function makeGenerator(o: GeneratorOpts): (faultRate: number, now?: Date) => StreamMessage {
  const rng = new Rng(o.seed);
  const names = fakerNames(o.locale ?? "en", o.seed);
  const forced = o.types?.length ? o.types : null;
  let i = o.startIndex ?? 0;
  return (faultRate: number, now?: Date): StreamMessage => {
    const profile: Profile = forced
      ? { ...o.profile, messageTypes: [[forced[i % forced.length]!, 1]] }
      : o.profile;
    const at = now ?? (o.liveTime ? new Date() : undefined);
    const m = generateMessage(rng, profile, names, i++, at ? { now: at } : undefined);
    if (faultRate > 0 && rng.next() < faultRate) {
      return { msg: rng.pick(FAULTS).apply(m.msg), type: m.type, injected: true };
    }
    return { msg: m.msg, type: m.type, injected: false };
  };
}
