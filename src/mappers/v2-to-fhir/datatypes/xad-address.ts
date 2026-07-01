/**
 * HL7v2 XAD to FHIR Address Mapping
 * Based on: HL7 Data Type - FHIR R4_ XAD[Address]
 */

import type { XAD } from "@healthsamurai/interbox/hl7v2";
import type { Address, Extension, Period } from "@healthsamurai/interbox/fhir/4.0.1";
import { convertSADToAddress } from "./sad-address.ts";
import { convertDRToPeriod } from "./dr-datetime.ts";

// ============================================================================
// Address Type Code Mappings (HL7 Table 0190)
// ============================================================================

const ADDRESS_TYPE_MAP: Record<string, Address["type"]> = {
  M: "postal",   // Mailing
  SH: "postal",  // Shipping
};

const ADDRESS_USE_MAP: Record<string, Address["use"]> = {
  BA: "billing",  // Bad address
  BI: "billing",  // Billing Address
  C: "temp",      // Current Or Temporary
  B: "work",      // Firm/Business
  H: "home",      // Home
  O: "work",      // Office/Business
};

// ============================================================================
// Extension URLs
// ============================================================================

const ISO_AD_USE_URL = "http://hl7.org/fhir/StructureDefinition/iso21090-AD-use";
const ADDRESS_TYPE_URL = "http://terminology.hl7.org/CodeSystem/v2-0190";
const CENSUS_TRACT_URL = "http://hl7.org/fhir/StructureDefinition/iso21090-ADXP-censusTract";

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Build period from XAD.12, XAD.13, XAD.14
 * XAD.13/14 take precedence over XAD.12
 */
function buildPeriod(xad: XAD): Period | undefined {
  const hasExplicitDates = xad.$13_start || xad.$14_end;

  if (hasExplicitDates) {
    const period: Period = {};
    if (xad.$13_start) {period.start = xad.$13_start;}
    if (xad.$14_end) {period.end = xad.$14_end;}
    return period;
  }

  return convertDRToPeriod(xad.$12_period);
}

/**
 * Build extensions from XAD.7 (Address Type) and XAD.10 (Census Tract)
 */
function buildExtensions(xad: XAD): Extension[] | undefined {
  const extensions: Extension[] = [];

  // XAD.7 = HV -> iso21090-AD-use extension
  if (xad.$7_type?.toUpperCase() === "HV") {
    extensions.push({
      url: ISO_AD_USE_URL,
      valueCode: "HV",
    });
  }

  // XAD.7 -> address type extension (for all values)
  if (xad.$7_type) {
    extensions.push({
      url: ADDRESS_TYPE_URL,
      valueCodeableConcept: {
        coding: [
          {
            system: "http://terminology.hl7.org/CodeSystem/v2-0190",
            code: xad.$7_type,
          },
        ],
      },
    });
  }

  // XAD.10 -> Census Tract extension
  if (xad.$10_censusTract) {
    extensions.push({
      url: CENSUS_TRACT_URL,
      valueString: xad.$10_censusTract,
    });
  }

  return extensions.length > 0 ? extensions : undefined;
}

// ============================================================================
// Main Converter Function
// ============================================================================

/**
 * Convert HL7v2 XAD (Extended Address) to FHIR Address
 *
 * Mapping:
 * - XAD.1 (SAD)        -> line[0-2] via SAD[Address]
 * - XAD.2              -> line[3]
 * - XAD.3              -> city
 * - XAD.4              -> state
 * - XAD.5              -> postalCode
 * - XAD.6              -> country
 * - XAD.7              -> type (M,SH) or use (BA,BI,C,B,H,O) + extensions
 * - XAD.9              -> district
 * - XAD.10             -> extension (census tract)
 * - XAD.12/13/14       -> period
 * - XAD.19             -> line[4]
 */
export function convertXADToAddress(xad: XAD | undefined): Address | undefined {
  if (!xad) {return undefined;}

  // Build address lines
  const line: string[] = [];

  // XAD.1: SAD -> lines 0-2
  const sadAddress = convertSADToAddress(xad.$1_line1);
  if (sadAddress?.line) {
    line.push(...sadAddress.line);
  }

  // XAD.2: Other Designation -> line[3]
  if (xad.$2_line2) {
    line.push(xad.$2_line2);
  }

  // XAD.19: Addressee -> line[4] (Note: XAD interface may not have this field)
  // The generated type doesn't include XAD.19, so we skip it

  // Check if we have any data
  const hasData =
    line.length > 0 ||
    xad.$3_city ||
    xad.$4_state ||
    xad.$5_postalCode ||
    xad.$6_country ||
    xad.$9_district;

  if (!hasData) {return undefined;}

  // XAD.7: Address Type -> type or use
  const addressTypeCode = xad.$7_type?.toUpperCase();
  const type = addressTypeCode ? ADDRESS_TYPE_MAP[addressTypeCode] : undefined;
  const use = addressTypeCode ? ADDRESS_USE_MAP[addressTypeCode] : undefined;

  // Build period
  const period = buildPeriod(xad);

  // Build extensions
  const extension = buildExtensions(xad);

  return {
    ...(line.length > 0 && { line }),
    ...(xad.$3_city && { city: xad.$3_city }),
    ...(xad.$4_state && { state: xad.$4_state }),
    ...(xad.$5_postalCode && { postalCode: xad.$5_postalCode }),
    ...(xad.$6_country && { country: xad.$6_country }),
    ...(xad.$9_district && { district: xad.$9_district }),
    ...(type && { type }),
    ...(use && { use }),
    ...(period && { period }),
    ...(extension && { extension }),
  };
}

/**
 * Convert array of XAD to array of Address
 */
export function convertXADArrayToAddresses(
  xads: XAD[] | undefined
): Address[] | undefined {
  if (!xads || xads.length === 0) {return undefined;}

  const addresses: Address[] = [];

  for (const xad of xads) {
    const address = convertXADToAddress(xad);
    if (address) {addresses.push(address);}
  }

  return addresses.length > 0 ? addresses : undefined;
}

