/**
 * ElderServe provider directory (CSV) → FHIR Practitioner.
 *
 * A client-specific mapper for the ElderServe per-payer "Provider" files. The
 * engine hands each CSV row to map() as a {@link CsvRow} (columns verbatim); ALL
 * interpretation lives here.
 *
 * Identity: Practitioner.id is derived from the NPI, so the many rows per
 * provider (one per practice site, and repeats across payer files) collapse into
 * ONE Practitioner (the sender upserts by id; resource_hash dedups unchanged
 * ones). Rows without an NPI are errored. Header keys are normalized (trim +
 * lowercase) to tolerate the casing / trailing-space drift across payer files;
 * values are trimmed (the source stores them verbatim).
 *
 * Site-level detail (specialty, network, hospital affiliations, accepting-new,
 * hours) is intentionally NOT on Practitioner — it belongs on a later
 * PractitionerRole / Location.
 */
import { defineMapper, domainError } from "@health-samurai/interbox";
import { csvParser } from "@health-samurai/interbox/builtins";
import type { CsvRow } from "@health-samurai/interbox/core";
import type {
  Practitioner,
  HumanName,
  ContactPoint,
  Address,
  CodeableConcept,
} from "@health-samurai/interbox/fhir/4.0.1";

const NPI_SYSTEM = "http://hl7.org/fhir/sid/us-npi";

const GENDER_MAP: Record<string, NonNullable<Practitioner["gender"]>> = {
  m: "male",
  male: "male",
  f: "female",
  female: "female",
  o: "other",
  other: "other",
  u: "unknown",
  unknown: "unknown",
};

/**
 * Build a case-insensitive, whitespace-tolerant lookup over a CSV row. Keys are
 * trimmed + lowercased; values are trimmed and empty ones dropped, so callers get
 * `undefined` for blank cells.
 */
function lookup(columns: Record<string, string>): (name: string) => string | undefined {
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(columns)) {
    const val = (v ?? "").trim();
    if (val) map.set(k.trim().toLowerCase(), val);
  }
  return (name) => map.get(name.trim().toLowerCase());
}

/** Convert one ElderServe provider row to a FHIR Practitioner. */
export function convertProviderRow(row: CsvRow): Practitioner {
  const get = lookup(row.columns);

  const npi = get("npi");
  if (!npi) {
    throw domainError(
      "field",
      "missing_npi",
      `provider row ${row.row} of ${row.file} has no NPI`,
    );
  }

  const practitioner: Practitioner = {
    resourceType: "Practitioner",
    id: npi,
    identifier: [{ system: NPI_SYSTEM, value: npi }],
  };

  // Name (+ degree as suffix)
  const family = get("last name");
  const given = [get("first name"), get("middle initial")].filter(
    (x): x is string => !!x,
  );
  const degree = get("degree");
  if (family || given.length > 0) {
    const name: HumanName = { use: "official" };
    if (family) name.family = family;
    if (given.length > 0) name.given = given;
    if (degree) name.suffix = [degree];
    practitioner.name = [name];
  }

  // Gender
  const genderRaw = get("gender");
  if (genderRaw) {
    const g = GENDER_MAP[genderRaw.toLowerCase()];
    if (g) practitioner.gender = g;
  }

  // Telecom
  const telecom: ContactPoint[] = [];
  const phone = get("phone number");
  const fax = get("fax number");
  const email = get("e mail address") ?? get("email address") ?? get("email");
  if (phone) telecom.push({ system: "phone", value: phone, use: "work" });
  if (fax) telecom.push({ system: "fax", value: fax, use: "work" });
  if (email) telecom.push({ system: "email", value: email });
  if (telecom.length > 0) practitioner.telecom = telecom;

  // Address
  const line = [get("street address"), get("room or suite") ?? get("ste")].filter(
    (x): x is string => !!x,
  );
  const city = get("city");
  const state = get("state");
  const zip = get("zip code") ?? get("zip");
  const zipExt = get("zip code extended");
  const county = get("county");
  if (line.length > 0 || city || state || zip) {
    const address: Address = { use: "work" };
    if (line.length > 0) address.line = line;
    if (city) address.city = city;
    if (state) address.state = state;
    if (zip) address.postalCode = zipExt ? `${zip}-${zipExt}` : zip;
    if (county) address.district = county;
    practitioner.address = [address];
  }

  // Communication — Language 1..7 (R4 Practitioner.communication is CodeableConcept[])
  const languages: CodeableConcept[] = [];
  for (let i = 1; i <= 7; i++) {
    const lang = get(`language ${i}`);
    if (lang) languages.push({ text: lang });
  }
  if (languages.length > 0) practitioner.communication = languages;

  // Qualification — the degree, as a coarse text code
  if (degree) {
    practitioner.qualification = [{ code: { text: degree } }];
  }

  return practitioner;
}

export const elderServeProvidersMapper = defineMapper({
  type: "elderserve-providers",
  parser: csvParser,
  // csvParser types `input` as CsvRow — no cast needed.
  map(_config, input) {
    return convertProviderRow(input);
  },
});
