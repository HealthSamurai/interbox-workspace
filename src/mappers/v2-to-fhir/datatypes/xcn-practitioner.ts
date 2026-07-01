/**
 * HL7v2 XCN to FHIR Practitioner Mapping
 * Based on: HL7 Data Type - FHIR R4_ XCN[Practitioner]
 */

import type { XCN } from "@health-samurai/interbox/hl7v2";
import type {
  Practitioner,
  PractitionerQualification,
  HumanName,
  Identifier,
  Extension,
  Period,
} from "@health-samurai/interbox/fhir/4.0.1";
import { convertHDToUri } from "./hd-converters.ts";
import { convertDRToPeriod } from "./dr-datetime.ts";
import { sanitizeForId } from "../support/string.ts";

// ============================================================================
// Name Type Code Mapping (HL7 Table 0200 -> FHIR name-use)
// ============================================================================

const NAME_TYPE_MAP: Record<string, HumanName["use"]> = {
  A: "usual",     // Alias Name
  B: "official",  // Name at Birth
  C: "official",  // Adopted Name
  D: "usual",     // Display Name
  L: "official",  // Legal Name
  M: "maiden",    // Maiden Name
  N: "nickname",  // Nickname
  P: "official",  // Name of Partner/Spouse
  R: "official",  // Registered Name
  S: "anonymous", // Pseudonym
  T: "temp",      // Temporary Name
  U: "old",       // Unknown
};

// ============================================================================
// Extension URLs
// ============================================================================

const CHECK_DIGIT_URL = "http://hl7.org/fhir/StructureDefinition/identifier-checkDigit";
const CHECK_DIGIT_SCHEME_URL = "http://hl7.org/fhir/StructureDefinition/namingsystem-checkDigit";
const NAME_ASSEMBLY_ORDER_URL = "http://hl7.org/fhir/R4/extension-humanname-assembly-order.html";

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Build identifier from XCN fields
 */
function buildIdentifier(xcn: XCN): Identifier | undefined {
  if (!xcn.$1_value) {return undefined;}

  const identifier: Identifier = {
    value: xcn.$1_value,
  };

  // XCN.9: Assigning Authority -> system
  const system = convertHDToUri(xcn.$9_system);
  if (system) {
    identifier.system = system;
  }

  // XCN.13: Identifier Type Code -> type
  if (xcn.$13_type) {
    identifier.type = {
      coding: [{ code: xcn.$13_type }],
    };
  }

  // Build extensions for check digit
  const extensions: Extension[] = [];

  // XCN.11: Check Digit
  if (xcn.$11_checkDigit) {
    extensions.push({
      url: CHECK_DIGIT_URL,
      valueString: xcn.$11_checkDigit,
    });
  }

  // XCN.12: Check Digit Scheme
  if (xcn.$12_checkDigitScheme) {
    extensions.push({
      url: CHECK_DIGIT_SCHEME_URL,
      valueString: xcn.$12_checkDigitScheme,
    });
  }

  if (extensions.length > 0) {
    identifier.extension = extensions;
  }

  return identifier;
}

/**
 * Build period from XCN.17, XCN.19, XCN.20
 * XCN.19/XCN.20 take precedence over XCN.17
 */
function buildNamePeriod(xcn: XCN): Period | undefined {
  const hasExplicitDates = xcn.$19_start || xcn.$20_end;

  if (hasExplicitDates) {
    const period: Period = {};
    if (xcn.$19_start) {period.start = xcn.$19_start;}
    if (xcn.$20_end) {period.end = xcn.$20_end;}
    return period;
  }

  return convertDRToPeriod(xcn.$17_period);
}

/**
 * Build name extensions from XCN.18 (Name Assembly Order)
 */
function buildNameExtensions(xcn: XCN): Extension[] | undefined {
  if (!xcn.$18_order) {return undefined;}

  return [
    {
      url: NAME_ASSEMBLY_ORDER_URL,
      valueCode: xcn.$18_order,
    },
  ];
}

/**
 * Build HumanName from XCN fields
 */
function buildName(xcn: XCN): HumanName | undefined {
  const hasNameData =
    xcn.$2_family?.$1_family ||
    xcn.$3_given ||
    xcn.$4_additionalGiven ||
    xcn.$5_suffix ||
    xcn.$6_prefix ||
    xcn.$21_credential;

  if (!hasNameData) {return undefined;}

  // Build given names
  const given: string[] = [];
  if (xcn.$3_given) {given.push(xcn.$3_given);}
  if (xcn.$4_additionalGiven) {given.push(xcn.$4_additionalGiven);}

  // Build suffixes
  const suffix: string[] = [];
  if (xcn.$5_suffix) {suffix.push(xcn.$5_suffix);}
  if (xcn.$21_credential) {suffix.push(xcn.$21_credential);}

  // Build prefix
  const prefix = xcn.$6_prefix ? [xcn.$6_prefix] : undefined;

  // XCN.10: Name Type Code -> use
  const use = xcn.$10_use ? NAME_TYPE_MAP[xcn.$10_use.toUpperCase()] : undefined;

  // Period from XCN.17/19/20
  const period = buildNamePeriod(xcn);

  // Extensions from XCN.18
  const extension = buildNameExtensions(xcn);

  return {
    ...(xcn.$2_family?.$1_family && { family: xcn.$2_family.$1_family }),
    ...(given.length > 0 && { given }),
    ...(prefix && { prefix }),
    ...(suffix.length > 0 && { suffix }),
    ...(use && { use }),
    ...(period && { period }),
    ...(extension && { extension }),
  };
}

/**
 * Build qualification from XCN.7 (Degree)
 */
function buildQualification(xcn: XCN): PractitionerQualification | undefined {
  if (!xcn.$7_qualification) {return undefined;}

  return {
    code: {
      coding: [{ code: xcn.$7_qualification }],
    },
  };
}

// ============================================================================
// Main Converter Function
// ============================================================================

/**
 * Convert HL7v2 XCN (Extended Composite ID Number and Name for Persons) to FHIR Practitioner
 *
 * Mapping:
 * - XCN.1          -> identifier.value
 * - XCN.2 (FN)     -> name.family
 * - XCN.3          -> name.given[0]
 * - XCN.4          -> name.given[1]
 * - XCN.5          -> name.suffix[0]
 * - XCN.6          -> name.prefix
 * - XCN.7          -> qualification.code
 * - XCN.9          -> identifier.system (via HD[uri])
 * - XCN.10         -> name.use
 * - XCN.11         -> identifier.extension (checkDigit)
 * - XCN.12         -> identifier.extension (checkDigitScheme)
 * - XCN.13         -> identifier.type.coding.code
 * - XCN.17         -> name.period (if XCN.19/20 not present)
 * - XCN.18         -> name.extension (assembly order)
 * - XCN.19         -> name.period.start
 * - XCN.20         -> name.period.end
 * - XCN.21         -> name.suffix[1]
 */
export function convertXCNToPractitioner(
  xcn: XCN | undefined
): Practitioner | undefined {
  if (!xcn) {return undefined;}

  const identifier = buildIdentifier(xcn);
  const name = buildName(xcn);
  const qualification = buildQualification(xcn);

  // Need at least identifier or name
  if (!identifier && !name) {return undefined;}

  return {
    resourceType: "Practitioner",
    ...(identifier && { identifier: [identifier] }),
    ...(name && { name: [name] }),
    ...(qualification && { qualification: [qualification] }),
  };
}

/**
 * Convert array of XCN to array of Practitioner
 */
export function convertXCNArrayToPractitioners(
  xcns: XCN[] | undefined
): Practitioner[] | undefined {
  if (!xcns || xcns.length === 0) {return undefined;}

  const practitioners: Practitioner[] = [];

  for (const xcn of xcns) {
    const practitioner = convertXCNToPractitioner(xcn);
    if (practitioner) {practitioners.push(practitioner);}
  }

  return practitioners.length > 0 ? practitioners : undefined;
}

/**
 * Generate a deterministic Practitioner/PractitionerRole ID from XCN identifier fields.
 * Uses convertHDToUri for the system component — same logic as
 * convertXCNToPractitioner uses for identifier.system, ensuring consistency.
 */
export function buildPractitionerIdFromXCN(xcn: XCN): string | undefined {
  if (!xcn.$1_value) {
    return undefined;
  }
  const system = convertHDToUri(xcn.$9_system);
  if (system) {
    return sanitizeForId(`${system}-${xcn.$1_value}`);
  }
  return sanitizeForId(xcn.$1_value);
}

