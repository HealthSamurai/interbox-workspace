/**
 * HL7v2 NTE Segment to FHIR Annotation Mapping
 * NTE segments typically follow OBX segments and contain notes/comments
 */

import type { NTE } from "@health-samurai/interbox/hl7v2";
import type { Annotation } from "@health-samurai/interbox/fhir/4.0.1";

/**
 * Convert multiple NTE segments to a single FHIR Annotation
 *
 * Rules:
 * - Multiple NTE segments are concatenated with newlines
 * - Empty NTE-3 values create paragraph breaks (double newline)
 * - Multiple values within a single NTE-3 are also joined with newlines
 *
 * @param ntes - Array of NTE segments following an OBX
 * @returns Annotation with concatenated text, or undefined if no content
 */
export function convertNTEsToAnnotation(
  ntes: NTE[],
): Annotation | undefined {
  if (!ntes || ntes.length === 0) {return undefined;}

  const textParts: string[] = [];

  for (const nte of ntes) {
    const comments = nte.$3_comment;

    if (!comments || comments.length === 0) {
      // Empty NTE-3 creates paragraph break
      textParts.push("");
    } else {
      // Concatenate multiple comment values within single NTE
      textParts.push(comments.join("\n"));
    }
  }

  // Join all parts with newlines
  const text = textParts.join("\n");

  // Return undefined if only whitespace
  if (!text.trim()) {
    // If there's at least some structure (paragraph breaks), include it
    if (text.includes("\n")) {
      return { text };
    }
    return undefined;
  }

  return { text };
}
