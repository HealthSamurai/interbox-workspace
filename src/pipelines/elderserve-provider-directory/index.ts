import { env, pipeline } from "@health-samurai/interbox";
import { aidboxSender, csvParser, s3CsvSource } from "@health-samurai/interbox/builtins";

import { elderServeProviderDirectoryMapper } from "../../mappers/elderserve-provider-directory/index.ts";

// ElderServe Plan-Net provider directory: three cross-referenced files per drop
// (providers / facilities / networks), delivered as a dated subfolder with a
// manifest. The `batch` config turns on the load barrier — a drop's rows are
// staged (unready) and released to the mapper only once the manifest confirms the
// whole drop has landed, so cross-file references are never resolved against
// half-loaded data. Path + pattern + batch shape are intrinsic to the feed
// (literals); only deployment/secret values come from env().
pipeline("elderserve-provider-directory")
  .source(
    s3CsvSource({
      id: "s3-elderserve-provider-directory",
      path: "provider-directory/",
      pattern: "\\.csv$",
      bucket: env("S3_CSV_BUCKET", "interbox-inbound"),
      endpoint: env("S3_CSV_ENDPOINT", "http://localhost:9000"),
      region: env("S3_CSV_REGION", "us-east-1"),
      accessKeyId: env("S3_CSV_ACCESS_KEY_ID"),
      secretAccessKey: env("S3_CSV_SECRET_ACCESS_KEY"),
      pollMs: 10000,
      // Complete-dataset gating: each subfolder under path is one drop/batch,
      // sealed when manifest.json lists every file and the row counts match.
      batch: {
        boundary: "subprefix",
        complete: { mode: "manifest", file: "manifest.json" },
      },
      parser: csvParser(),
    }),
  )
  .mapper(elderServeProviderDirectoryMapper())
  .sender(
    aidboxSender({
      url: env("AIDBOX_URL"),
      auth: { kind: "basic", user: env("AIDBOX_CLIENT_ID", "root"), password: env("AIDBOX_CLIENT_SECRET") },
    }),
  );
