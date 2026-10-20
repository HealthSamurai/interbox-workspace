import { env } from "@health-samurai/interbox";
import { aidbox, fhirItems, skipUnchanged } from "@health-samurai/interbox/aidbox";
import { mllpSource, pipeline, postgresStore } from "@health-samurai/interbox/chain";
import { hl7v2Parser } from "@health-samurai/interbox/hl7v2";
import { v2ToFhir } from "../../mappers/v2-to-fhir/index.ts";

pipeline("hl7-to-aidbox")
  .source(mllpSource({ host: env("MLLP_HOST"), port: env("MLLP_PORT") }))
  .step((raws) => raws.withSearchText((raw) => raw))
  .store(postgresStore({ codec: "text" }), {
    index: { message_type: "btree", event_type: "btree", patient_id: "btree" },
    search: "trgm",
  })
  .step(hl7v2Parser())
  .step(v2ToFhir)
  .step(fhirItems())
  .step(skipUnchanged())
  .sender(
    aidbox({
      url: env("AIDBOX_URL"),
      auth: { kind: "basic", user: env("AIDBOX_CLIENT_ID", "root"), password: env("AIDBOX_CLIENT_SECRET") },
    }),
  );
