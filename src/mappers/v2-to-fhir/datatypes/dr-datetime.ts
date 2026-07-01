import type { DR } from "@health-samurai/interbox/hl7v2";
import type { Period } from "@health-samurai/interbox/fhir/4.0.1";

/**
 * Converts DR (Date/Time Range) to FHIR dateTime.
 *
 * Mapping:
 * - DR.1 (Range Start Date/Time) -> dateTime
 *
 * Note: HL7v2 date format (YYYYMMDDHHMMSS) may need conversion to
 * FHIR format (YYYY-MM-DDTHH:MM:SS). This basic implementation
 * returns the value as-is; format conversion should be handled separately.
 */
export function convertDRToDateTime(dr: DR | undefined): string | undefined {
  if (!dr) {return undefined;}

  return dr.$1_start;
}

/**
 * Converts DR (Date/Time Range) to FHIR Period.
 *
 * Mapping:
 * - DR.1 (Range Start Date/Time) -> start
 * - DR.2 (Range End Date/Time) -> end
 */
export function convertDRToPeriod(dr: DR | undefined): Period | undefined {
  if (!dr) {return undefined;}
  if (!dr.$1_start && !dr.$2_end) {return undefined;}

  const period: Period = {};

  if (dr.$1_start) {period.start = dr.$1_start;}
  if (dr.$2_end) {period.end = dr.$2_end;}

  return period;
}
