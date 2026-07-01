import type { Sender } from "../support/msh.ts";

// Local code mapping is sender-scoped: each (sending application, sending
// facility) gets its own ConceptMap per mapping type, so two feeds can map the
// same local code to different targets. Phase 1 ships a single mapping type:
// OBX-3 observation identifier -> LOINC.

export const OBSERVATION_CODE_LOINC = "observation-code-loinc";
export const LOINC_SYSTEM = "http://loinc.org";

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * Deterministic ConceptMap id for a sender's observation-code map, e.g.
 * `hl7v2-labcorp-hospa-observation-code-loinc`. Computed from MSH-3/MSH-4 so the
 * mapper never needs a lookup to find the right map. Mirrors the reference app's
 * generateConceptMapId.
 */
export function generateConceptMapId(sender: Sender): string {
  return `hl7v2-${slug(sender.sendingApplication)}-${slug(sender.sendingFacility)}-${OBSERVATION_CODE_LOINC}`;
}
