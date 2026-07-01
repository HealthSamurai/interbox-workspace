/**
 * HL7v2 XTN to FHIR ContactPoint Mapping
 * Based on: HL7 Data Type - FHIR R4_ XTN[ContactPoint]
 */

import type { XTN } from "@healthsamurai/interbox/hl7v2";
import type { ContactPoint, Extension } from "@healthsamurai/interbox/fhir/4.0.1";

// ============================================================================
// Telecommunication Equipment Type Mapping (HL7 Table 0202)
// ============================================================================

const EQUIPMENT_TYPE_MAP: Record<string, ContactPoint["system"]> = {
  PH: "phone",    // Telephone
  CP: "phone",    // Cellular or Mobile Phone
  FX: "fax",      // Fax
  Internet: "email", // Internet Address
  "X.400": "email",  // X.400 email address
  BP: "pager",    // Beeper
  SAT: "phone",   // Satellite Phone
  TDD: "other",   // Telecommunications Device for the Deaf
  TTY: "other",   // Teletypewriter
  MD: "phone",    // Modem
};

// Equipment types that use XTN.4 (email address) instead of phone
const EMAIL_EQUIPMENT_TYPES = ["Internet", "X.400"];

// ============================================================================
// Telecommunication Use Code Mapping (HL7 Table 0201)
// ============================================================================

const USE_CODE_MAP: Record<string, ContactPoint["use"]> = {
  ASN: "work",    // Answering Service Number
  BPN: "work",    // Beeper Number
  EMR: "temp",    // Emergency Number
  NET: "work",    // Network (email) Address
  ORN: "home",    // Other Residence Number
  PRN: "home",    // Primary Residence Number
  VHN: "home",    // Vacation Home Number
  WPN: "work",    // Work Number
};

// ============================================================================
// Extension URLs
// ============================================================================

const COUNTRY_CODE_URL = "http://hl7.org/fhir/StructureDefinition/contactpoint-country";
const AREA_CODE_URL = "http://hl7.org/fhir/StructureDefinition/contactpoint-area";
const LOCAL_NUMBER_URL = "http://hl7.org/fhir/StructureDefinition/contactpoint-local";
const EXTENSION_URL = "http://hl7.org/fhir/StructureDefinition/contactpoint-extension";

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Determine the system from XTN.3 or infer from valued fields
 */
function mapSystem(xtn: XTN): ContactPoint["system"] | undefined {
  if (xtn.$3_system) {
    return EQUIPMENT_TYPE_MAP[xtn.$3_system] || "other";
  }

  // If XTN.3 not valued but XTN.4 (email) is valued, default to email
  if (xtn.$4_email) {
    return "email";
  }

  // If XTN.1, XTN.7, or XTN.12 is valued (phone number fields), default to phone
  if (xtn.$1_value || xtn.$7_localNumber || xtn.$12_unformatted) {
    return "phone";
  }

  return undefined;
}

/**
 * Build the value string from XTN fields
 * Priority:
 * 1. For email types (Internet, X.400) or when XTN.4 is valued: use XTN.4
 * 2. For phone types: use XTN.12 (unformatted) if available
 * 3. For phone types: use XTN.1 if XTN.7 and XTN.12 not valued
 * 4. Build from components (XTN.5, XTN.6, XTN.7, XTN.8)
 */
function buildValue(xtn: XTN): string | undefined {
  const isEmailType = xtn.$3_system && EMAIL_EQUIPMENT_TYPES.includes(xtn.$3_system);

  // For email types or when XTN.4 (email) is valued, use XTN.4
  if (isEmailType || xtn.$4_email) {
    return xtn.$4_email;
  }

  // For non-email types, try XTN.12 first
  if (xtn.$12_unformatted) {
    return xtn.$12_unformatted;
  }

  // If XTN.7 (local number) is valued, build from components
  if (xtn.$7_localNumber) {
    const parts: string[] = [];

    // +country area local Xext
    if (xtn.$5_countryCode) {
      parts.push(`+${xtn.$5_countryCode}`);
    }

    if (xtn.$6_areaCode) {
      parts.push(xtn.$6_areaCode);
    }

    parts.push(xtn.$7_localNumber);

    if (xtn.$8_extension) {
      parts.push(`X${xtn.$8_extension}`);
    }

    return parts.join(" ");
  }

  // Fall back to XTN.1 if no components available
  return xtn.$1_value;
}

/**
 * Build extensions for phone number components
 */
function buildExtensions(xtn: XTN): Extension[] | undefined {
  const isEmailType = xtn.$3_system && EMAIL_EQUIPMENT_TYPES.includes(xtn.$3_system);

  // Don't add phone extensions for email types
  if (isEmailType) {return undefined;}

  const extensions: Extension[] = [];

  // XTN.5: Country Code
  if (xtn.$5_countryCode) {
    extensions.push({
      url: COUNTRY_CODE_URL,
      valueString: xtn.$5_countryCode,
    });
  }

  // XTN.6: Area/City Code
  if (xtn.$6_areaCode) {
    extensions.push({
      url: AREA_CODE_URL,
      valueString: xtn.$6_areaCode,
    });
  }

  // XTN.7: Local Number
  if (xtn.$7_localNumber) {
    extensions.push({
      url: LOCAL_NUMBER_URL,
      valueString: xtn.$7_localNumber,
    });
  }

  // XTN.8: Extension
  if (xtn.$8_extension) {
    extensions.push({
      url: EXTENSION_URL,
      valueString: xtn.$8_extension,
    });
  }

  return extensions.length > 0 ? extensions : undefined;
}

// ============================================================================
// Main Converter Function
// ============================================================================

/**
 * Convert HL7v2 XTN (Extended Telecommunication Number) to FHIR ContactPoint
 *
 * Mapping:
 * - XTN.1          -> value (for phone, if XTN.7 and XTN.12 not valued)
 * - XTN.2          -> use
 * - XTN.3          -> system
 * - XTN.4          -> value (for email types)
 * - XTN.5          -> extension (country code)
 * - XTN.6          -> extension (area code)
 * - XTN.7          -> extension (local number), also used for value
 * - XTN.8          -> extension (extension)
 * - XTN.12         -> value (for phone, unformatted)
 */
export function convertXTNToContactPoint(
  xtn: XTN | undefined
): ContactPoint | undefined {
  if (!xtn) {return undefined;}

  const system = mapSystem(xtn);
  const value = buildValue(xtn);

  // Need at least a value
  if (!value) {return undefined;}

  // XTN.2: Use Code
  const use = xtn.$2_use ? USE_CODE_MAP[xtn.$2_use.toUpperCase()] : undefined;

  // Build extensions
  const extension = buildExtensions(xtn);

  return {
    ...(system && { system }),
    ...(value && { value }),
    ...(use && { use }),
    ...(extension && { extension }),
  };
}

/**
 * Convert array of XTN to array of ContactPoint
 */
export function convertXTNArrayToContactPoints(
  xtns: XTN[] | undefined
): ContactPoint[] | undefined {
  if (!xtns || xtns.length === 0) {return undefined;}

  const contactPoints: ContactPoint[] = [];

  for (const xtn of xtns) {
    const contactPoint = convertXTNToContactPoint(xtn);
    if (contactPoint) {contactPoints.push(contactPoint);}
  }

  return contactPoints.length > 0 ? contactPoints : undefined;
}

