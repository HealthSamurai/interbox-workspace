/**
 * Converts HL7v2 DTM (YYYYMMDDHHMMSS) to FHIR dateTime (YYYY-MM-DDTHH:MM:SSZ).
 * Handles partial dates: YYYY, YYYY-MM, YYYY-MM-DD, full datetime.
 */
export function convertDTMToDateTime(
  dtm: string | undefined,
): string | undefined {
  if (!dtm) {
    return undefined;
  }

  const year = dtm.substring(0, 4);
  const month = dtm.substring(4, 6);
  const day = dtm.substring(6, 8);
  const hour = dtm.substring(8, 10) || "00";
  const minute = dtm.substring(10, 12) || "00";
  const second = dtm.substring(12, 14) || "00";

  if (dtm.length <= 4) {
    return year;
  }
  if (dtm.length <= 6) {
    return `${year}-${month}`;
  }
  if (dtm.length <= 8) {
    return `${year}-${month}-${day}`;
  }

  return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
}

/**
 * Converts HL7v2 DTM (YYYYMMDDHHMMSS) to FHIR date (YYYY-MM-DD).
 * Handles partial dates: YYYY, YYYY-MM, YYYY-MM-DD.
 * Time components are truncated.
 */
export function convertDTMToDate(dtm: string | undefined): string | undefined {
  if (!dtm) {
    return undefined;
  }
  const year = dtm.substring(0, 4);
  const month = dtm.substring(4, 6);
  const day = dtm.substring(6, 8);
  if (dtm.length <= 4) {
    return year;
  }
  if (dtm.length <= 6) {
    return `${year}-${month}`;
  }
  return `${year}-${month}-${day}`;
}
