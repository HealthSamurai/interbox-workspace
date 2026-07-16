import { env, pipeline } from "@health-samurai/interbox";
import { aidboxSender, s3CsvSnapshot } from "@health-samurai/interbox/builtins";
import { closureFanout, closureHandler } from "../../csv/closure.ts";
import { flatfhirBuild, type FlatfhirView } from "../../csv/flatfhir-build.ts";

// A minimal end-to-end CSV-import demo (not ElderServe) — just enough to exercise
// the whole pipeline: two flat CSVs → two flatfhir views → a cross-view reference
// → one reference-closed transaction in Aidbox.
//
//   snapshot (a dated folder + manifest.json):
//     organizations.csv  id,name
//     patients.csv        id,name,org   (org → Organization/<org>)
//
// The pipeline is pure workspace code on the generic rails: an s3CsvSnapshot
// source (emits ingest_file) → build (flatfhir) → root (closure) → Aidbox.

const views: FlatfhirView[] = [
  {
    resource: "Organization",
    table: "organization", // scratch table organization_<snapshot>
    key: "id",
    columns: {
      id: { path: ["id"] },
      name: { path: ["name"] },
    },
  },
  {
    resource: "Patient",
    table: "patient", // scratch table patient_<snapshot>
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
      endpoint: env("S3_CSV_ENDPOINT", "http://localhost:9000"),
      accessKeyId: env("S3_CSV_ACCESS_KEY_ID"),
      secretAccessKey: env("S3_CSV_SECRET_ACCESS_KEY"),
    }),
  )
  .stage("build", { barrier: true, handler: flatfhirBuild(views) })
  .stage("root", { barrier: true, handler: closureHandler(), fanout: closureFanout() })
  .sender(
    aidboxSender({
      url: env("AIDBOX_URL"),
      auth: { kind: "basic", user: env("AIDBOX_CLIENT_ID", "root"), password: env("AIDBOX_CLIENT_SECRET") },
    }),
  );
