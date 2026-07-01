import type { HD } from "@healthsamurai/interbox/hl7v2";
import type { Identifier, CodeableConcept } from "@healthsamurai/interbox/fhir/4.0.1";

/**
 * Converts HD (Hierarchic Designator) to URI.
 *
 * Mapping:
 * - HD.1 (Namespace ID) -> uri (if valued)
 * - HD.2 (Universal ID) with HD.3 = "ISO" -> "urn:oid:" + HD.2
 * - HD.2 (Universal ID) with HD.3 = "UUID" -> "urn:uuid:" + HD.2
 * - HD.2 (Universal ID) with other HD.3 -> HD.2 as-is
 */
export function convertHDToUri(hd: HD | undefined): string | undefined {
  if (!hd) {return undefined;}

  // If namespace is valued, use it directly
  if (hd.$1_namespace) {
    return hd.$1_namespace;
  }

  // Otherwise, use Universal ID with appropriate prefix
  if (hd.$2_system) {
    if (hd.$3_systemType === "ISO") {
      return `urn:oid:${hd.$2_system}`;
    }
    if (hd.$3_systemType === "UUID") {
      return `urn:uuid:${hd.$2_system}`;
    }
    return hd.$2_system;
  }

  return undefined;
}

/**
 * Converts HD (Hierarchic Designator) to array of Identifiers.
 *
 * Mapping:
 * - HD.1 (Namespace ID) -> identifier[0].value
 * - HD.2 (Universal ID) -> identifier[1].value
 * - HD.3 (Universal ID Type) -> identifier[1].type and optionally system
 */
export function convertHDToIdentifiers(hd: HD | undefined): Identifier[] | undefined {
  if (!hd) {return undefined;}

  const identifiers: Identifier[] = [];

  // First identifier from namespace
  if (hd.$1_namespace) {
    identifiers.push({
      value: hd.$1_namespace,
    });
  }

  // Second identifier from universal ID
  if (hd.$2_system) {
    const identifier: Identifier = {
      value: hd.$2_system,
    };

    if (hd.$3_systemType) {
      identifier.type = {
        coding: [{ code: hd.$3_systemType }],
      };

      // Add system for ISO/UUID types
      if (hd.$3_systemType === "ISO" || hd.$3_systemType === "UUID") {
        identifier.system = "urn:ietf:rfc:3986";
      }
    }

    identifiers.push(identifier);
  }

  return identifiers.length > 0 ? identifiers : undefined;
}

/** Partial Device data */
interface DeviceIdentifierData {
  identifier?: Identifier[];
}

/**
 * Converts HD (Hierarchic Designator) to Device identifier data.
 *
 * Uses the same mapping as convertHDToIdentifiers.
 */
export function convertHDToDevice(hd: HD | undefined): DeviceIdentifierData | undefined {
  const identifiers = convertHDToIdentifiers(hd);
  if (!identifiers) {return undefined;}

  return { identifier: identifiers };
}

/** Partial Organization data */
interface OrganizationIdentifierData {
  identifier?: Identifier[];
}

/**
 * Converts HD (Hierarchic Designator) to Organization identifier data.
 *
 * Uses the same mapping as convertHDToIdentifiers.
 */
export function convertHDToOrganization(hd: HD | undefined): OrganizationIdentifierData | undefined {
  const identifiers = convertHDToIdentifiers(hd);
  if (!identifiers) {return undefined;}

  return { identifier: identifiers };
}

/** Partial Location data */
interface LocationData {
  name?: string;
  identifier?: Identifier;
  physicalType?: CodeableConcept;
}

/**
 * Converts HD (Hierarchic Designator) to Location data.
 *
 * Mapping:
 * - HD.1 (Namespace ID) -> name
 * - HD.2 (Universal ID) with ISO/UUID -> identifier.value
 * - physicalType set to "si" (site)
 */
export function convertHDToLocation(hd: HD | undefined): LocationData | undefined {
  if (!hd) {return undefined;}
  if (!hd.$1_namespace && !hd.$2_system) {return undefined;}

  const location: LocationData = {};

  if (hd.$1_namespace) {
    location.name = hd.$1_namespace;
  }

  if (hd.$2_system && (hd.$3_systemType === "ISO" || hd.$3_systemType === "UUID")) {
    location.identifier = {
      value: hd.$2_system,
    };
  }

  // Set physical type to site
  location.physicalType = {
    coding: [
      {
        system: "http://terminology.hl7.org/CodeSystem/location-physical-type",
        code: "si",
      },
    ],
  };

  return location;
}

/** MessageHeader endpoint data */
interface MessageHeaderEndpointData {
  endpoint?: string;
  name?: string;
}

/**
 * Converts HD (Hierarchic Designator) to MessageHeader source/destination endpoint.
 *
 * Mapping:
 * - HD.2 with HD.3 = "ISO" -> "urn:oid:" + HD.2
 * - HD.2 with HD.3 = "UUID" -> "urn:uuid:" + HD.2
 * - HD.2 with HD.3 = "DNS" -> "urn:dns:" + HD.2
 * - HD.2 with HD.3 = "URI" -> HD.2 as-is
 * - HD.1 -> name (when HD.2 not valued or HD.3 not standard type)
 */
export function convertHDToMessageHeaderEndpoint(hd: HD | undefined): MessageHeaderEndpointData | undefined {
  if (!hd) {return undefined;}
  if (!hd.$1_namespace && !hd.$2_system) {return undefined;}

  const result: MessageHeaderEndpointData = {};

  if (hd.$2_system) {
    switch (hd.$3_systemType) {
      case "ISO":
        result.endpoint = `urn:oid:${hd.$2_system}`;
        break;
      case "UUID":
        result.endpoint = `urn:uuid:${hd.$2_system}`;
        break;
      case "DNS":
        result.endpoint = `urn:dns:${hd.$2_system}`;
        break;
      case "URI":
        result.endpoint = hd.$2_system;
        break;
      default:
        // Non-standard type, use name instead
        if (hd.$1_namespace) {
          result.name = `${hd.$1_namespace} - ${hd.$3_systemType || ""}:${hd.$2_system}`;
        }
        break;
    }
  } else if (hd.$1_namespace) {
    result.name = hd.$1_namespace;
  }

  return result;
}

/**
 * Converts HD (Hierarchic Designator) to MessageHeader source name.
 *
 * Mapping:
 * - HD.1 (Namespace ID) -> name
 */
export function convertHDToMessageHeaderName(hd: HD | undefined): string | undefined {
  if (!hd) {return undefined;}
  return hd.$1_namespace;
}
