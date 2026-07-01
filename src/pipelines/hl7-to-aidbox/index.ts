import { env, pipeline } from "@health-samurai/interbox";
import { aidboxSender, hl7v2Parser, mllpSource } from "@health-samurai/interbox/builtins";

import { v2ToFhirMapper } from "../../mappers/v2-to-fhir/index.ts";

// Ingest HL7v2 over MLLP, map each message to FHIR, and write the resources to
// Aidbox. Every stage is referenced by value — built-in source/parser/sender
// descriptors and the workspace mapper — so types (incl. the source↔mapper
// parser match) are checked at compile time. Deployment values come from env().
pipeline("hl7-to-aidbox")
  .source(
    mllpSource({
      id: "mllp-default",
      host: env("MLLP_HOST"),
      port: env("MLLP_PORT"),
      parser: hl7v2Parser({ skipZSegments: false }),
    }),
  )
  .mapper(v2ToFhirMapper())
  .sender(
    aidboxSender({
      url: env("AIDBOX_URL"),
      auth: { kind: "basic", user: "root", password: env("AIDBOX_SECRET") },
    }),
  );
