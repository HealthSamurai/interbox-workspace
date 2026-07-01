/**
 * HL7v2 XPN to FHIR HumanName Mapping
 * Based on: HL7 Data Type - FHIR R4_ XPN[HumanName]
 */

import type { XPN, DR } from "@healthsamurai/interbox/hl7v2";
import type { HumanName, Period, Extension } from "@healthsamurai/interbox/fhir/4.0.1";

// ============================================================================
// Name Type Code Mapping (HL7 Table 0200 -> FHIR name-use)
// ============================================================================

const NAME_TYPE_MAP: Record<string, HumanName["use"]> = {
  BAD: "old",
  D: "usual",
  L: "official",
  M: "maiden",
  MSK: "anonymous",
  N: "nickname",
  NAV: "temp",
  R: "official",
  TEMP: "temp",
};

// ============================================================================
// Name Assembly Order Mapping (HL7 Table 0444)
// ============================================================================

const NAME_ASSEMBLY_ORDER_EXTENSION_URL =
  "http://hl7.org/fhir/StructureDefinition/humanname-assembly-order";

const NAME_ASSEMBLY_ORDER_MAP: Record<string, string> = {
  G: "NL1", // Prefix Given Middle Family Suffix
  F: "NL2", // Prefix Family Middle Given Suffix
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Convert HL7v2 datetime string to FHIR dateTime
 * Handles formats: YYYY, YYYYMM, YYYYMMDD, YYYYMMDDHHMM, YYYYMMDDHHMMSS
 */
function convertDateTime(dt: string | undefined): string | undefined {
  if (!dt) {return undefined;}

  // Extract date components
  const year = dt.substring(0, 4);
  const month = dt.substring(4, 6);
  const day = dt.substring(6, 8);
  const hour = dt.substring(8, 10);
  const minute = dt.substring(10, 12);
  const second = dt.substring(12, 14);

  if (dt.length === 4) {return year;}
  if (dt.length === 6) {return `${year}-${month}`;}
  if (dt.length === 8) {return `${year}-${month}-${day}`;}
  if (dt.length >= 12) {
    const base = `${year}-${month}-${day}T${hour}:${minute}`;
    if (dt.length >= 14) {return `${base}:${second}`;}
    return `${base}:00`;
  }

  return dt;
}

/**
 * Convert DR (Date Range) to FHIR Period
 */
function convertDRToPeriod(dr: DR | undefined): Period | undefined {
  if (!dr) {return undefined;}

  const start = convertDateTime(dr.$1_start);
  const end = convertDateTime(dr.$2_end);

  if (!start && !end) {return undefined;}

  return {
    ...(start && { start }),
    ...(end && { end }),
  };
}

/**
 * Map XPN.7 Name Type Code to FHIR HumanName.use
 */
function mapNameUse(nameTypeCode: string | undefined): HumanName["use"] {
  if (!nameTypeCode) {return undefined;}
  return NAME_TYPE_MAP[nameTypeCode.toUpperCase()];
}

/**
 * Build period from XPN.10, XPN.12, XPN.13
 * XPN.10 is used only if XPN.12 AND XPN.13 are not valued
 */
function buildPeriod(xpn: XPN): Period | undefined {
  const hasExplicitDates = xpn.$12_start || xpn.$13_end;

  if (hasExplicitDates) {
    const start = convertDateTime(xpn.$12_start);
    const end = convertDateTime(xpn.$13_end);
    if (!start && !end) {return undefined;}
    return {
      ...(start && { start }),
      ...(end && { end }),
    };
  }

  // Fall back to XPN.10 Name Validity Range
  return convertDRToPeriod(xpn.$10_period);
}

/**
 * Build extensions from XPN.11 Name Assembly Order
 */
function buildExtensions(xpn: XPN): Extension[] | undefined {
  if (!xpn.$11_order) {return undefined;}

  const code = NAME_ASSEMBLY_ORDER_MAP[xpn.$11_order.toUpperCase()];
  if (!code) {return undefined;}

  return [
    {
      url: NAME_ASSEMBLY_ORDER_EXTENSION_URL,
      valueCode: code,
    },
  ];
}

// ============================================================================
// Main Converter Function
// ============================================================================

/**
 * Convert HL7v2 XPN (Extended Person Name) to FHIR HumanName
 *
 * Mapping:
 * - XPN.1 (FN)     -> family (from FN.1 Surname)
 * - XPN.2          -> given[0]
 * - XPN.3          -> given[1]
 * - XPN.4          -> suffix[0]
 * - XPN.5          -> prefix
 * - XPN.6          -> suffix[1] (degree)
 * - XPN.7          -> use (via NameType vocabulary)
 * - XPN.10         -> period (if XPN.12 and XPN.13 not valued)
 * - XPN.11         -> extension (humanname-assembly-order)
 * - XPN.12         -> period.start
 * - XPN.13         -> period.end
 * - XPN.14         -> suffix[2] (professional suffix)
 */
export function convertXPNToHumanName(xpn: XPN | undefined): HumanName | undefined {
  if (!xpn) {return undefined;}

  // XPN.1: Family Name (FN datatype)
  const family = xpn.$1_family?.$1_family;

  // XPN.2: Given Name -> given[0]
  // XPN.3: Second and Further Given Names -> given[1]
  const given: string[] = [];
  if (xpn.$2_given) {given.push(xpn.$2_given);}
  if (xpn.$3_additionalGiven) {given.push(xpn.$3_additionalGiven);}

  // Must have at least family or given
  if (!family && given.length === 0) {return undefined;}

  // XPN.5: Prefix -> prefix
  const prefix = xpn.$5_prefix ? [xpn.$5_prefix] : undefined;

  // XPN.4: Suffix -> suffix[0]
  // XPN.6: Degree -> suffix[1]
  // XPN.14: Professional Suffix -> suffix[2]
  const suffix: string[] = [];
  if (xpn.$4_suffix) {suffix.push(xpn.$4_suffix);}
  if (xpn.$6_qualification) {suffix.push(xpn.$6_qualification);}
  if (xpn.$14_credential) {suffix.push(xpn.$14_credential);}

  // XPN.7: Name Type Code -> use
  const use = mapNameUse(xpn.$7_use);

  // Period from XPN.10, XPN.12, XPN.13
  const period = buildPeriod(xpn);

  // Extensions from XPN.11
  const extension = buildExtensions(xpn);

  // Build text representation
  const textParts: string[] = [];
  if (prefix) {textParts.push(...prefix);}
  if (given.length > 0) {textParts.push(...given);}
  if (family) {textParts.push(family);}
  if (suffix.length > 0) {textParts.push(...suffix);}

  return {
    ...(use && { use }),
    ...(family && { family }),
    ...(given.length > 0 && { given }),
    ...(prefix && { prefix }),
    ...(suffix.length > 0 && { suffix }),
    ...(period && { period }),
    ...(extension && { extension }),
    ...(textParts.length > 0 && { text: textParts.join(" ") }),
  };
}

/**
 * Convert XPN to string (for XPN[string] mapping)
 * Concatenates name parts according to XPN.11 (assembly order)
 * Default order: Prefix Given Family Suffix
 */
export function convertXPNToString(xpn: XPN | undefined): string | undefined {
  if (!xpn) {return undefined;}

  const parts: string[] = [];

  // XPN.11 determines assembly order
  // F = Family name first (Prefix Family Given Suffix)
  // G = Given name first (Prefix Given Family Suffix) - default
  const isFamilyFirst = xpn.$11_order?.toUpperCase() === "F";

  // Prefix
  if (xpn.$5_prefix) {parts.push(xpn.$5_prefix);}

  if (isFamilyFirst) {
    // Family first order
    if (xpn.$1_family?.$1_family) {parts.push(xpn.$1_family.$1_family);}
    if (xpn.$2_given) {parts.push(xpn.$2_given);}
    if (xpn.$3_additionalGiven) {parts.push(xpn.$3_additionalGiven);}
  } else {
    // Given first order (default)
    if (xpn.$2_given) {parts.push(xpn.$2_given);}
    if (xpn.$3_additionalGiven) {parts.push(xpn.$3_additionalGiven);}
    if (xpn.$1_family?.$1_family) {parts.push(xpn.$1_family.$1_family);}
  }

  // Suffixes
  if (xpn.$4_suffix) {parts.push(xpn.$4_suffix);}
  if (xpn.$6_qualification) {parts.push(xpn.$6_qualification);}
  if (xpn.$14_credential) {parts.push(xpn.$14_credential);}

  if (parts.length === 0) {return undefined;}

  return parts.join(" ");
}

