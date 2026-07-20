import { env, pipeline } from "@health-samurai/interbox";
import { aidboxSender, s3CsvSnapshot } from "@health-samurai/interbox/builtins";
import { closureFanout, closureHandler } from "../../mappers/csv/closure.ts";
import { buildFanout, flatfhirBuild, type FlatfhirView } from "../../mappers/csv/flatfhir-build.ts";

// A minimal end-to-end CSV-import demo (not ElderServe) — just enough to exercise
// the whole pipeline: two flat CSVs → two flatfhir views → a cross-view reference
// → one reference-closed transaction in Aidbox.
//
//   snapshot (a dated folder + manifest.json):
//     organizations.csv  id,name
//     patients.csv        id,name,org   (org → Organization/<org>)
//
// The pipeline is pure workspace code on the generic rails: an s3CsvSnapshot
// source (detects a ready snapshot, emits one ingest_file per file) → the engine
// ingest_file stage (loads each CSV → scratch table, in parallel) → build
// (flatfhir, one message per resource type) → root (closure) → Aidbox. A
// .finalize() hook drops the snapshot's schema once it drains.

const views: FlatfhirView[] = [
  {
    resource: "Organization",
    // Logical type = manifest file's derived type: organizations.csv → "organizations".
    table: "organizations",
    key: "id",
    columns: {
      id: { path: ["id"] },
      name: { path: ["name"] },
    },
  },
  {
    resource: "Patient",
    // Logical type = manifest file's derived type: patients.csv → "patients".
    table: "patients",
    key: "id",
    columns: {
      id: { path: ["id"] },
      // single "name" column → HumanName.text
      name: { path: ["name", [{ use: "official" }], "text"] },
      // "org" column → Patient.managingOrganization → Organization/<org>
      org: { ref: ["managingOrganization"], type: "Organization" },
    },
  },
];

pipeline("csv-demo")
  .source(
    s3CsvSnapshot({
      bucket: env("S3_CSV_BUCKET", "interbox-inbound"),
      path: env("S3_CSV_PREFIX", "demo/"),
      manifest: "manifest.json",
      // Per-snapshot working schema; the engine force-prefixes `ibx_`, so this
      // resolves to e.g. `ibx_csv_demo_2026_07_17_run`.
      schema: "<pipeline>_<snapshot>",
      endpoint: env("S3_CSV_ENDPOINT", "http://localhost:9000"),
      accessKeyId: env("S3_CSV_ACCESS_KEY_ID"),
      secretAccessKey: env("S3_CSV_SECRET_ACCESS_KEY"),
    }),
  )
  .stage("build", { barrier: true, handler: flatfhirBuild(views), fanout: buildFanout(views) })
  .stage("root", { barrier: true, handler: closureHandler(), fanout: closureFanout() })
  .sender(
    aidboxSender({
      url: env("AIDBOX_URL"),
      auth: { kind: "basic", user: env("AIDBOX_CLIENT_ID", "root"), password: env("AIDBOX_CLIENT_SECRET") },
    }),
  )
  // Post-processing: once every stage drains for a snapshot, drop its ephemeral
  // schema. `schema.drop()` is scoped to THIS snapshot's schema (engine-enforced).
  .finalize(({ schema }) => schema.drop());
