/**
 * Shared string utility functions
 */

/**
 * Convert string to kebab-case
 * "Essential Hypertension" → "essential-hypertension"
 * "LAB_SYSTEM" → "lab-system"
 */
export function toKebabCase(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "-") // Replace non-alphanumeric chars (including underscores) with hyphens
    .replace(/\s+/g, "-") // Replace spaces with hyphens
    .replace(/-+/g, "-") // Collapse multiple hyphens
    .replace(/^-|-$/g, ""); // Trim leading/trailing hyphens
}

/**
 * Sanitize a string for use as a FHIR resource ID.
 * Lowercases and replaces non-alphanumeric characters (except hyphens) with hyphens.
 */
export const sanitizeForId = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9-]/g, "-");
