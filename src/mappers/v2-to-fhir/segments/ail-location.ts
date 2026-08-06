/**
 * HL7v2 AIL Segment to FHIR Location Mapping
 *
 * AIL names the location a scheduled appointment needs. AIL-3 is a PL, so it can
 * carry a whole hierarchy (point of care, room, bed, building, floor, facility) in
 * one field; this emits one Location for it, identified by every part the sender
 * populated, and lets Appointment.participant reference it.
 *
 * Mapping:
 * - AIL.3 -> id, identifier, name, description, physicalType
 * - AIL.4 -> type (location type, e.g. "Outpatient")
 */

import type { AIL, PL } from "@health-samurai/interbox/hl7v2";
import type { Location } from "@health-samurai/interbox/fhir/4.0.1";
import { convertCEToCodeableConcept } from "../datatypes/ce-codeableconcept.ts";
import { convertPLToLocation } from "../datatypes/pl-converters.ts";
import { toKebabCase } from "../support/string.ts";

const LOCATION_RESOURCE_ID_SYSTEM = "urn:hl7v2:ail-3:location-resource-id";

/** PL parts, coarse to fine, paired with the label used in the description. */
const PL_PARTS: { label: string; get: (pl: PL) => string | undefined }[] = [
  { label: "Point of care", get: (pl) => pl.$1_careSite },
  { label: "Building", get: (pl) => pl.$7_building },
  { label: "Floor", get: (pl) => pl.$8_floor },
  { label: "Room", get: (pl) => pl.$2_room },
  { label: "Bed", get: (pl) => pl.$3_bed },
];

function presentParts(pl: PL): { label: string; value: string }[] {
  return PL_PARTS.flatMap(({ label, get }) => {
    const value = get(pl)?.trim();
    return value ? [{ label, value }] : [];
  });
}

/**
 * Deterministic Location.id: kebab("<PL.4 facility || MSH-4 facility>-<every
 * populated PL part, coarse to fine>"). Every part is included because senders
 * reuse room and bed names across buildings — "260" alone is not an identity.
 *
 * Returns undefined when AIL-3 is empty, which makes the segment unmappable.
 */
export function locationIdFromPL(
  pl: PL,
  sendingFacility: string,
): string | undefined {
  const parts = presentParts(pl);
  if (parts.length === 0) {
    return undefined;
  }

  const scope = pl.$4_facility?.$1_namespace || sendingFacility;
  return toKebabCase(`${scope}-${parts.map((p) => p.value).join("-")}`);
}

/**
 * Convert an AIL segment to a FHIR Location. Returns undefined when AIL-3
 * carries nothing to identify a location by; the caller skips such segments.
 */
export function convertAILToLocation(
  ail: AIL,
  sendingFacility: string,
): Location | undefined {
  const pl = ail.$3_locationResourceId?.[0];
  if (!pl) {
    return undefined;
  }

  const id = locationIdFromPL(pl, sendingFacility);
  if (!id) {
    return undefined;
  }

  const parts = presentParts(pl);
  // PL.9 is the sender's own label for the location; fall back to the coarsest
  // part (usually the point of care) when it is absent.
  const name = pl.$9_description?.trim() || parts[0]?.value;
  const description = parts.map((p) => `${p.label} ${p.value}`).join(", ");
  const type = convertCEToCodeableConcept(ail.$4_locationType);
  const physicalType = convertPLToLocation(pl)?.physicalType;

  return {
    resourceType: "Location",
    id,
    identifier: [
      {
        system: LOCATION_RESOURCE_ID_SYSTEM,
        value: parts.map((p) => p.value).join("^"),
      },
    ],
    ...(name && { name }),
    ...(description && { description }),
    ...(type && { type: [type] }),
    ...(physicalType && { physicalType }),
  };
}
