/**
 * ElderServe provider directory (Plan-Net CSV spec) → FHIR.
 *
 * The spec delivers three file types per drop, gated by the load barrier so a
 * whole drop maps together:
 *   - providers.csv  → Practitioner   (id = NPI)
 *   - facilities.csv → Organization   (id = NPI)
 *   - networks.csv   → Organization   (network; id = slug(network_id))
 *
 * The source stamps each row's `fileType` (grouping shards like providers_1.csv /
 * providers_2.csv), so map() routes on it. One row per (NPI + location + plan +
 * specialty) means a provider spans many rows; id = NPI collapses them into one
 * Practitioner (the sender upserts by id).
 *
 * SCOPE (v1): the base resources above, from single rows. The cross-file
 * references — PractitionerRole.network / .organization, OrganizationAffiliation
 * — are NOT built yet: they need the mapper to resolve sibling rows within the
 * sealed batch (a mapper-context extension). Rows of an unrecognized type map to
 * nothing (processed, no resource).
 */
import { defineMapper, domainError } from "@health-samurai/interbox";
import { csvParser } from "@health-samurai/interbox/builtins";
import type { CsvRow } from "@health-samurai/interbox/core";
import type {
  Address,
  CodeableConcept,
  ContactPoint,
  HumanName,
  Organization,
  Practitioner,
} from "@health-samurai/interbox/fhir/4.0.1";

const NPI_SYSTEM = "http://hl7.org/fhir/sid/us-npi";

const GENDER_MAP: Record<string, NonNullable<Practitioner["gender"]>> = {
  male: "male",
  female: "female",
  other: "other",
  unknown: "unknown",
};

/** Trimmed cell accessor over a row; blank cells read as undefined. Header names
 *  are exact per the spec, so no fuzzy normalization is needed. */
function reader(columns: Record<string, string>): (name: string) => string | undefined {
  return (name) => {
    const v = (columns[name] ?? "").trim();
    return v.length ? v : undefined;
  };
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Shared address builder for the provider/facility line + city/state/zip cols. */
function addressOf(get: (n: string) => string | undefined): Address | undefined {
  const line = [get("address_line1"), get("address_line2")].filter((x): x is string => !!x);
  const city = get("city");
  const state = get("state");
  const zip = get("zip");
  const county = get("county");
  if (!line.length && !city && !state && !zip) return undefined;
  const address: Address = { use: "work" };
  if (line.length) address.line = line;
  if (city) address.city = city;
  if (state) address.state = state;
  if (zip) address.postalCode = zip;
  if (county) address.district = county;
  return address;
}

function toPractitioner(row: CsvRow): Practitioner {
  const get = reader(row.columns);
  const npi = get("npi");
  if (!npi) throw domainError("field", "missing_npi", `providers row ${row.row} of ${row.file} has no npi`);

  const p: Practitioner = {
    resourceType: "Practitioner",
    id: npi,
    active: true,
    identifier: [{ system: NPI_SYSTEM, value: npi }],
  };

  const family = get("last_name");
  const given = [get("first_name"), get("middle_name")].filter((x): x is string => !!x);
  if (family || given.length) {
    const name: HumanName = { use: "official" };
    if (family) name.family = family;
    if (given.length) name.given = given;
    const prefix = get("name_prefix");
    const suffix = get("name_suffix");
    if (prefix) name.prefix = [prefix];
    if (suffix) name.suffix = [suffix];
    p.name = [name];
  }

  const sex = get("sex");
  if (sex) {
    const g = GENDER_MAP[sex.toLowerCase()];
    if (g) p.gender = g;
  }

  const phone = get("phone");
  if (phone) p.telecom = [{ system: "phone", value: phone, use: "work" }];

  const address = addressOf(get);
  if (address) p.address = [address];

  const langs = (get("languages") ?? "").split(";").map((s) => s.trim()).filter(Boolean);
  if (langs.length) p.communication = langs.map((l): CodeableConcept => ({ text: l }));

  const board = get("board_certification");
  if (board) p.qualification = [{ code: { text: board } }];

  return p;
}

function toFacilityOrg(row: CsvRow): Organization {
  const get = reader(row.columns);
  const npi = get("npi");
  if (!npi) throw domainError("field", "missing_npi", `facilities row ${row.row} of ${row.file} has no npi`);

  const org: Organization = {
    resourceType: "Organization",
    id: npi,
    active: true,
    identifier: [{ system: NPI_SYSTEM, value: npi }],
  };
  const name = get("facility_name");
  if (name) org.name = name;
  const nucc = get("facility_type_nucc");
  if (nucc) {
    org.type = nucc.split(";").map((c) => c.trim()).filter(Boolean).map(
      (code): CodeableConcept => ({ coding: [{ system: "http://nucc.org/provider-taxonomy", code }] }),
    );
  }
  const address = addressOf(get);
  if (address) org.address = [address];
  const phone = get("phone");
  if (phone) org.telecom = [{ system: "phone", value: phone, use: "work" }];
  return org;
}

function toNetworkOrg(row: CsvRow): Organization {
  const get = reader(row.columns);
  const id = get("network_id");
  if (!id) throw domainError("field", "missing_network_id", `networks row ${row.row} of ${row.file} has no network_id`);
  const org: Organization = {
    resourceType: "Organization",
    id: `network-${slug(id)}`,
    active: true,
    // Plan-Net "network" flavor.
    type: [
      {
        coding: [
          { system: "http://hl7.org/fhir/us/davinci-pdex-plan-net/CodeSystem/OrgTypeCS", code: "ntwk", display: "Network" },
        ],
      },
    ],
  };
  const name = get("network_name");
  if (name) org.name = name;
  return org;
}

export const elderServeProviderDirectoryMapper = defineMapper({
  type: "elderserve-provider-directory",
  parser: csvParser,
  map(_config, input) {
    switch (input.fileType) {
      case "providers":
        return toPractitioner(input);
      case "facilities":
        return toFacilityOrg(input);
      case "networks":
        return toNetworkOrg(input);
      default:
        return []; // unrecognized file type → no resource, row still marked processed
    }
  },
});
