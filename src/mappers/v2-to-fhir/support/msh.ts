import type { MSH } from "@healthsamurai/interbox/hl7v2";
import { domainError } from "@healthsamurai/interbox";

export interface Sender {
  sendingApplication: string;
  sendingFacility: string;
}

/**
 * Extract sending application (MSH-3.1) and sending facility (MSH-4.1).
 * Both are required to scope deterministic resource ids.
 */
export function senderFromMsh(msh: MSH): Sender {
  const sendingApplication = msh.$3_sendingApplication?.$1_namespace;
  const sendingFacility = msh.$4_sendingFacility?.$1_namespace;

  if (!sendingApplication || !sendingFacility) {
    throw domainError(
      "field",
      "missing_sender",
      `MSH-3 (sending application) and MSH-4 (sending facility) are required. ` +
        `Got: MSH-3="${sendingApplication || ""}", MSH-4="${sendingFacility || ""}"`,
    );
  }

  return { sendingApplication, sendingFacility };
}
