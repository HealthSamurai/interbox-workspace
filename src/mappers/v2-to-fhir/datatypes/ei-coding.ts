import type { EI } from "@healthsamurai/interbox/hl7v2";
import type { Coding, Identifier, Reference } from "@healthsamurai/interbox/fhir/4.0.1";

/**
 * Converts EI (Entity Identifier) to FHIR Coding.
 *
 * Mapping:
 * - EI.1 (Entity Identifier) -> code
 * - EI.2 (Namespace ID) -> system
 */
export function convertEIToCoding(ei: EI | undefined): Coding | undefined {
  if (!ei) {return undefined;}
  if (!ei.$1_value) {return undefined;}

  return {
    code: ei.$1_value,
    ...(ei.$2_namespace && { system: ei.$2_namespace }),
  };
}

/**
 * Converts EI (Entity Identifier) to FHIR Identifier with system from Universal ID.
 *
 * Mapping:
 * - EI.1 (Entity Identifier) -> value
 * - EI.3 (Universal ID) -> system
 */
export function convertEIToIdentifierSystem(ei: EI | undefined): Identifier | undefined {
  if (!ei) {return undefined;}
  if (!ei.$1_value) {return undefined;}

  return {
    value: ei.$1_value,
    ...(ei.$3_system && { system: ei.$3_system }),
  };
}

/**
 * Converts EI (Entity Identifier) to FHIR Identifier with extension pattern.
 *
 * Mapping:
 * - EI.1 (Entity Identifier) -> value
 * - EI.2 (Namespace ID) -> system
 */
export function convertEIToIdentifierExtension(ei: EI | undefined): Identifier | undefined {
  if (!ei) {return undefined;}
  if (!ei.$1_value) {return undefined;}

  return {
    value: ei.$1_value,
    ...(ei.$2_namespace && { system: ei.$2_namespace }),
  };
}

/**
 * Converts EI (Entity Identifier) to FHIR Identifier with Organization assigner.
 *
 * Mapping:
 * - EI.1 (Entity Identifier) -> value
 * - EI.2 (Namespace ID) -> assigner.display
 */
export function convertEIToIdentifierOrganization(ei: EI | undefined): Identifier | undefined {
  if (!ei) {return undefined;}
  if (!ei.$1_value) {return undefined;}

  const identifier: Identifier = {
    value: ei.$1_value,
  };

  if (ei.$2_namespace) {
    identifier.assigner = {
      display: ei.$2_namespace,
    } as Reference<"Organization">;
  }

  return identifier;
}

/**
 * Converts EI (Entity Identifier) to FHIR Identifier with default assigner.
 *
 * Mapping:
 * - EI.1 (Entity Identifier) -> value
 * - EI.2 (Namespace ID) -> assigner.identifier.value
 * - EI.3 (Universal ID) -> assigner.identifier.system
 */
export function convertEIToIdentifierDefaultAssigner(ei: EI | undefined): Identifier | undefined {
  if (!ei) {return undefined;}
  if (!ei.$1_value) {return undefined;}

  const identifier: Identifier = {
    value: ei.$1_value,
  };

  if (ei.$2_namespace || ei.$3_system) {
    identifier.assigner = {
      identifier: {
        ...(ei.$2_namespace && { value: ei.$2_namespace }),
        ...(ei.$3_system && { system: ei.$3_system }),
      },
    } as Reference<"Organization">;
  }

  return identifier;
}

/** Partial Condition data with identifier */
interface ConditionIdentifierData {
  identifier: Identifier;
}

/**
 * Converts EI (Entity Identifier) to Condition identifier data.
 *
 * Mapping:
 * - EI.1 (Entity Identifier) -> identifier.value
 * - EI.2 (Namespace ID) -> assigner.identifier.value
 * - EI.3 (Universal ID) -> assigner.identifier.system
 * - EI.4 (Universal ID Type) -> assigner.identifier.type
 */
export function convertEIToCondition(ei: EI | undefined): ConditionIdentifierData | undefined {
  if (!ei) {return undefined;}
  if (!ei.$1_value) {return undefined;}

  const identifier: Identifier = {
    value: ei.$1_value,
  };

  if (ei.$2_namespace || ei.$3_system || ei.$4_systemType) {
    const assignerIdentifier: Identifier = {};

    if (ei.$2_namespace) {assignerIdentifier.value = ei.$2_namespace;}
    if (ei.$3_system) {assignerIdentifier.system = ei.$3_system;}
    if (ei.$4_systemType) {
      assignerIdentifier.type = {
        coding: [{ code: ei.$4_systemType }],
      };
    }

    identifier.assigner = {
      identifier: assignerIdentifier,
    } as Reference<"Organization">;
  }

  return { identifier };
}

/** Partial Procedure data with identifier */
interface ProcedureIdentifierData {
  identifier: Identifier;
}

/**
 * Converts EI (Entity Identifier) to Procedure identifier data.
 *
 * Mapping:
 * - EI.1 (Entity Identifier) -> identifier.value
 */
export function convertEIToProcedure(ei: EI | undefined): ProcedureIdentifierData | undefined {
  if (!ei) {return undefined;}
  if (!ei.$1_value) {return undefined;}

  return {
    identifier: {
      value: ei.$1_value,
    },
  };
}

/** Device UDI carrier data */
interface DeviceUdiCarrierData {
  deviceIdentifier: string;
}

/**
 * Converts EI (Entity Identifier) to Device UDI carrier data.
 *
 * Mapping:
 * - EI.1 (Entity Identifier) -> udiCarrier.deviceIdentifier
 */
export function convertEIToDeviceUdiCarrier(ei: EI | undefined): DeviceUdiCarrierData | undefined {
  if (!ei) {return undefined;}
  if (!ei.$1_value) {return undefined;}

  return {
    deviceIdentifier: ei.$1_value,
  };
}

/**
 * EIP (Entity Identifier Pair) structure for HL7v2.
 * Note: May not be in generated types, defined here for converter use.
 */
interface EIP {
  /** EIP.1 - Placer Assigned Identifier */
  $1_placerAssignedIdentifier?: EI;
  /** EIP.2 - Filler Assigned Identifier */
  $2_fillerAssignedIdentifier?: EI;
}

const IDENTIFIER_TYPE_SYSTEM = "http://terminology.hl7.org/CodeSystem/v2-0203";

/**
 * Converts EI to a typed FHIR Identifier (EI[Identifier-Extension] + type code).
 *
 * Used for ORC-2 (PLAC) and ORC-3 (FILL) on Immunization per V2-to-FHIR IG.
 *
 * Mapping:
 * - EI.1 (Entity Identifier) -> value
 * - EI.2 (Namespace ID) -> system
 * - Fixed: type.coding.code = typeCode
 * - Fixed: type.coding.system = "http://terminology.hl7.org/CodeSystem/v2-0203"
 */
export function convertEIToTypedIdentifier(
  ei: EI | undefined,
  typeCode: "FILL" | "PLAC",
): Identifier | undefined {
  const baseIdentifier = convertEIToIdentifierExtension(ei);
  if (!baseIdentifier) {return undefined;}

  return {
    ...baseIdentifier,
    type: { coding: [{ system: IDENTIFIER_TYPE_SYSTEM, code: typeCode }] },
  };
}

/**
 * Converts EIP (Entity Identifier Pair) to Placer-assigned Identifier.
 *
 * Mapping:
 * - EIP.1 (Placer Assigned Identifier) -> value
 * - Fixed: type.coding.code = "PGN"
 * - Fixed: type.coding.system = "http://terminology.hl7.org/CodeSystem/v2-0203"
 */
export function convertEIPToPlacerAssignedIdentifier(eip: EIP | undefined): Identifier | undefined {
  if (!eip) {return undefined;}
  if (!eip.$1_placerAssignedIdentifier?.$1_value) {return undefined;}

  return {
    value: eip.$1_placerAssignedIdentifier.$1_value,
    type: {
      coding: [
        {
          system: IDENTIFIER_TYPE_SYSTEM,
          code: "PGN",
        },
      ],
    },
  };
}

/**
 * Converts EIP (Entity Identifier Pair) to Filler-assigned Identifier.
 *
 * Mapping:
 * - EIP.2 (Filler Assigned Identifier) -> value
 * - Fixed: type.coding.code = "FGN"
 * - Fixed: type.coding.system = "http://terminology.hl7.org/CodeSystem/v2-0203"
 */
export function convertEIPToFillerAssignedIdentifier(eip: EIP | undefined): Identifier | undefined {
  if (!eip) {return undefined;}
  if (!eip.$2_fillerAssignedIdentifier?.$1_value) {return undefined;}

  return {
    value: eip.$2_fillerAssignedIdentifier.$1_value,
    type: {
      coding: [
        {
          system: IDENTIFIER_TYPE_SYSTEM,
          code: "FGN",
        },
      ],
    },
  };
}
