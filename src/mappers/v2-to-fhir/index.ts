/**
 * HL7v2 → FHIR mapper — the default sample. Routes on MSH-9 to per-message
 * converters (segments/ + messages/), emitting flat FHIR resource arrays with
 * deterministic ids. This is yours to extend: add message types to the switch,
 * tweak the segment/datatype converters, or fork it entirely.
 *
 * The engine parses each inbound message and calls map() with the parsed
 * segments and a MapperContext (terminology). One mapper drains ALL received
 * rows (mappers compete via SKIP LOCKED), so routing lives here.
 */
import {
  defineMapper,
  domainError,
  provenanceFor,
  type MapperContext,
} from "@health-samurai/interbox";
import { fromMSH, type HL7v2Segment } from "@health-samurai/interbox/hl7v2";
import { hl7v2Parser } from "@health-samurai/interbox/builtins";
import type { Resource } from "@health-samurai/interbox/fhir";
import { convertADT_A01 } from "./messages/adt-a01.ts";
import { convertADT_A03 } from "./messages/adt-a03.ts";
import { convertADT_A08 } from "./messages/adt-a08.ts";
import { convertORM_O01 } from "./messages/orm-o01.ts";
import { convertORU_R01 } from "./messages/oru-r01.ts";
import { convertSIU_S12 } from "./messages/siu-s12.ts";
import { convertVXU_V04 } from "./messages/vxu-v04.ts";
import { findSegment } from "./support/segments.ts";

/**
 * Route a parsed message to its converter. Exported for offline testing. `ctx`
 * (terminology) is threaded only to ORU for OBX-3 → LOINC resolution; omitting
 * it (tests) keeps OBX-3 as a raw passthrough.
 */
export async function convertToFhir(
  segments: HL7v2Segment[],
  ctx?: MapperContext,
): Promise<unknown[]> {
  const mshSegment = findSegment(segments, "MSH");
  if (!mshSegment) {
    throw domainError("parse", "missing_msh", "message has no MSH segment");
  }
  const messageType = fromMSH(mshSegment).$9_messageType;
  const code = messageType?.$1_code;
  const event = messageType?.$2_event;
  if (!code && !event) {
    throw domainError("field", "missing_message_type", "MSH-9 is empty");
  }
  if (!code || !event) {
    throw domainError(
      "type",
      "invalid_message_type",
      `MSH-9 must carry both code and event, got "${code ?? ""}^${event ?? ""}"`,
    );
  }

  // Routed on the code alone: every SIU trigger event (S12 booking through S26
  // no-show) uses the SIU_S12 structure, and the converter reads the event to
  // infer a status when SCH-25 does not carry one.
  if (code === "SIU") {
    return convertSIU_S12(segments, event);
  }

  switch (`${code}_${event}`) {
    case "ADT_A01":
    // A04 (register) shares the A01 structure per the v2-to-FHIR IG.
    case "ADT_A04":
      return convertADT_A01(segments);
    case "ADT_A03":
      return convertADT_A03(segments);
    case "ADT_A08":
      return convertADT_A08(segments);
    case "ORU_R01":
      return await convertORU_R01(segments, ctx);
    case "ORM_O01":
      return convertORM_O01(segments);
    case "VXU_V04":
      return convertVXU_V04(segments);
    default:
      throw domainError(
        "unsupported",
        "message_type",
        `no converter for message type ${code}^${event}`,
      );
  }
}

export const v2ToFhirMapper = defineMapper({
  type: "v2-to-fhir",
  parser: hl7v2Parser,
  // The hl7v2Parser descriptor types `input` as HL7v2Segment[] — no cast needed.
  async map(_config, input, ctx) {
    const resources = await convertToFhir(input, ctx);

    // Provenance the destination can hold. Interbox records which message
    // produced each resource on the queue row itself and sends nothing of its own,
    // so if you want that visible in your FHIR server, emit it — one Provenance
    // per inbound message, targeting everything the message produced.
    //
    // Its `target` references make the sender ship it in the same bundle as those
    // resources, and its id is derived from the message, so re-running a message
    // overwrites its own record instead of piling up duplicates.
    //
    // Returns undefined when nothing addressable was produced; dropping it then
    // matters, because a resource without resourceType + id fails the whole
    // message. Delete this block if you don't want Provenance at the destination.
    const provenance = provenanceFor(ctx, resources as Resource[]);
    return provenance ? [...resources, provenance] : resources;
  },
});
