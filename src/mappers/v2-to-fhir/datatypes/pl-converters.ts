import type { PL, HD } from "@healthsamurai/interbox/hl7v2";
import type { Identifier, CodeableConcept, Reference } from "@healthsamurai/interbox/fhir/4.0.1";
import { convertHDToIdentifiers } from "./hd-converters.ts";

const LOCATION_PHYSICAL_TYPE_SYSTEM = "http://terminology.hl7.org/CodeSystem/location-physical-type";

/** Physical type codes for location hierarchy */
const PHYSICAL_TYPE = {
  BED: "bd",
  ROOM: "ro",
  FLOOR: "lvl",
  POINT_OF_CARE: "poc",
  BUILDING: "bu",
  SITE: "si",
} as const;

/** Partial Location data */
interface LocationData {
  identifier?: Identifier[];
  mode?: "instance" | "kind";
  physicalType?: CodeableConcept;
  status?: string;
  description?: string;
  partOf?: Reference;
}

/** Location hierarchy result from PL conversion */
interface PLLocationHierarchy {
  /** Bed location (most granular) */
  bed?: LocationData;
  /** Room location */
  room?: LocationData;
  /** Floor location */
  floor?: LocationData;
  /** Point of Care location */
  pointOfCare?: LocationData;
  /** Building location */
  building?: LocationData;
  /** Facility location (least granular) */
  facility?: LocationData;
  /** The most granular location available (for references) */
  mostGranular?: LocationData;
}

/**
 * Creates a physical type CodeableConcept.
 */
function createPhysicalType(code: string): CodeableConcept {
  return {
    coding: [
      {
        system: LOCATION_PHYSICAL_TYPE_SYSTEM,
        code,
      },
    ],
  };
}

/**
 * Creates LocationData from an HD field value (for simple string fields like room, bed).
 */
function createLocationFromString(value: string | undefined, physicalTypeCode: string): LocationData | undefined {
  if (!value) {return undefined;}

  return {
    identifier: [{ value }],
    mode: "instance",
    physicalType: createPhysicalType(physicalTypeCode),
  };
}

/**
 * Creates LocationData from an HD field.
 */
function createLocationFromHD(hd: HD | undefined, physicalTypeCode: string): LocationData | undefined {
  if (!hd) {return undefined;}

  const identifiers = convertHDToIdentifiers(hd);
  if (!identifiers || identifiers.length === 0) {return undefined;}

  return {
    identifier: identifiers,
    mode: "instance",
    physicalType: createPhysicalType(physicalTypeCode),
  };
}

/**
 * Converts PL (Person Location) to Location hierarchy.
 *
 * Returns a hierarchy of Location resources from most granular to least:
 * Bed -> Room -> Floor -> Point of Care -> Building -> Facility
 *
 * Each Location references its parent via partOf.
 *
 * Mapping:
 * - PL.1 (Point of Care) -> Location with physicalType "poc"
 * - PL.2 (Room) -> Location with physicalType "ro"
 * - PL.3 (Bed) -> Location with physicalType "bd"
 * - PL.4 (Facility) -> Location with physicalType "si"
 * - PL.5 (Location Status) -> status on all locations
 * - PL.7 (Building) -> Location with physicalType "bu"
 * - PL.8 (Floor) -> Location with physicalType "lvl"
 * - PL.9 (Location Description) -> description on most granular
 */
export function convertPLToLocationHierarchy(pl: PL | undefined): PLLocationHierarchy | undefined {
  if (!pl) {return undefined;}

  const hierarchy: PLLocationHierarchy = {};

  // Create location for each component
  if (pl.$3_bed) {
    hierarchy.bed = createLocationFromString(pl.$3_bed, PHYSICAL_TYPE.BED);
  }

  if (pl.$2_room) {
    hierarchy.room = createLocationFromString(pl.$2_room, PHYSICAL_TYPE.ROOM);
  }

  if (pl.$8_floor) {
    hierarchy.floor = createLocationFromString(pl.$8_floor, PHYSICAL_TYPE.FLOOR);
  }

  if (pl.$1_careSite) {
    hierarchy.pointOfCare = createLocationFromString(pl.$1_careSite, PHYSICAL_TYPE.POINT_OF_CARE);
  }

  if (pl.$7_building) {
    hierarchy.building = createLocationFromString(pl.$7_building, PHYSICAL_TYPE.BUILDING);
  }

  if (pl.$4_facility) {
    hierarchy.facility = createLocationFromHD(pl.$4_facility, PHYSICAL_TYPE.SITE);
  }

  // Set status on all locations if provided
  if (pl.$5_status) {
    const status = pl.$5_status;
    if (hierarchy.bed) {hierarchy.bed.status = status;}
    if (hierarchy.room) {hierarchy.room.status = status;}
    if (hierarchy.floor) {hierarchy.floor.status = status;}
    if (hierarchy.pointOfCare) {hierarchy.pointOfCare.status = status;}
    if (hierarchy.building) {hierarchy.building.status = status;}
    if (hierarchy.facility) {hierarchy.facility.status = status;}
  }

  // Determine most granular location and set description
  const granularityOrder = [
    hierarchy.bed,
    hierarchy.room,
    hierarchy.floor,
    hierarchy.pointOfCare,
    hierarchy.building,
    hierarchy.facility,
  ];

  for (const location of granularityOrder) {
    if (location) {
      hierarchy.mostGranular = location;
      if (pl.$9_description) {
        location.description = pl.$9_description;
      }
      break;
    }
  }

  // Return undefined if no locations were created
  if (!hierarchy.mostGranular) {return undefined;}

  return hierarchy;
}

/**
 * Converts PL (Person Location) to a single Location (the most granular).
 *
 * Use this when you only need the primary location reference.
 */
export function convertPLToLocation(pl: PL | undefined): LocationData | undefined {
  const hierarchy = convertPLToLocationHierarchy(pl);
  return hierarchy?.mostGranular;
}
