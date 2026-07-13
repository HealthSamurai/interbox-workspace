import { env, pipeline } from "@health-samurai/interbox";
import { aidboxSender, csvParser, s3CsvSource } from "@health-samurai/interbox/builtins";

import { elderServeProvidersMapper } from "../../mappers/elderserve-providers/index.ts";

// Ingest ElderServe provider-directory CSVs from an S3 bucket, map each row to a
// FHIR Practitioner, and write to Aidbox. Deployment values (bucket, endpoint,
// credentials) come from env() so the definition stays portable and secret-free.
pipeline("elderserve-providers")
  .source(
    s3CsvSource({
      id: "s3-elderserve-providers",
      // What this feed ingests is intrinsic to the pipeline, so path + pattern
      // are literals here — NOT env(). Only values that vary by environment or
      // are secret (bucket, endpoint, region, credentials) come from env().
      path: "elderserve/providers/",
      // Regex on the object basename: take .csv, skip the .xlsx copies. Facility-
      // schema files (FacilityFull, ExpressScript) also match but error as
      // missing_npi in the mapper (expected — they're Organizations, not people).
      pattern: "\\.csv$",
      bucket: env("S3_CSV_BUCKET", "interbox-inbound"),
      endpoint: env("S3_CSV_ENDPOINT", "http://localhost:9000"),
      region: env("S3_CSV_REGION", "us-east-1"),
      accessKeyId: env("S3_CSV_ACCESS_KEY_ID"),
      secretAccessKey: env("S3_CSV_SECRET_ACCESS_KEY"),
      pollMs: 10000,
      parser: csvParser(),
    }),
  )
  .mapper(elderServeProvidersMapper())
  .sender(
    aidboxSender({
      url: env("AIDBOX_URL"),
      auth: { kind: "basic", user: env("AIDBOX_CLIENT_ID", "root"), password: env("AIDBOX_CLIENT_SECRET") },
    }),
  );
