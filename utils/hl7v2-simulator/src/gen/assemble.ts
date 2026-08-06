import type { Rng } from "./rng.ts";
import type { NameProvider } from "./names.ts";
import type { Profile } from "../profile/schema.ts";
import { makeIdentity } from "./sample/identity.ts";
import { BUILDERS } from "./grammar/message-types.ts";

export interface GeneratedMessage {
  msg: string;
  type: string;
  event: string;
}

export interface GenerateOpts {
  /** Pin MSH-7 (and the derived collect time) to this instant instead of
   *  sampling the profile's year range. */
  now?: Date;
}

/**
 * Build one synthetic HL7v2 message by sampling the profile and filling a
 * grammar skeleton — valid by construction. No real data is touched; everything
 * comes from `profile` (aggregate distributions) + synthetic identity.
 */
export function generateMessage(rng: Rng, profile: Profile, names: NameProvider, index: number, opts?: GenerateOpts): GeneratedMessage {
  const mt = rng.weighted(profile.messageTypes);
  const caret = mt.indexOf("^");
  const type = caret >= 0 ? mt.slice(0, caret) : mt;
  const event = caret >= 0 ? mt.slice(caret + 1) : "";
  const builder = BUILDERS[type];
  if (!builder) throw new Error(`no builder registered for message type "${type}" (from "${mt}")`);
  const id = makeIdentity(rng, names, profile, index, opts?.now);
  const segs = builder({ rng, profile, id, index }, event);
  return { msg: segs.join("\r"), type, event };
}
