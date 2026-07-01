export {
  convertDTMToDate,
  convertDTMToDateTime,
} from "../support/datetime.ts";

/** Partial Annotation data for time field */
interface AnnotationTimeData {
  time: string;
}

/**
 * Converts DTM (Date/Time) to Annotation time data.
 *
 * Mapping:
 * - DTM -> time (dateTime)
 *
 * This returns data that can be merged into an Annotation.
 * The Annotation's required `text` field must be set separately.
 */
export function convertDTMToAnnotationTime(
  dtm: string | undefined,
): AnnotationTimeData | undefined {
  if (!dtm) {
    return undefined;
  }

  return {
    time: dtm,
  };
}
