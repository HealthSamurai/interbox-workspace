import { domainError, provenanceId } from "@health-samurai/interbox";
import { defineStep, type Batch, type RowContext } from "@health-samurai/interbox/chain";
import type { Provenance, Resource } from "@health-samurai/interbox/fhir";
import { fromMSH, type HL7v2Message, type HL7v2Segment } from "@health-samurai/interbox/hl7v2";
import type { Terminology } from "./code-mapping/observation-code-resolver.ts";
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
  ctx?: Terminology,
): Promise<Resource[]> {
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

type Identified = Resource & { readonly id: string };

const isIdentified = (resource: Resource): resource is Identified => typeof resource.id === "string";

function provenanceOf(ctx: RowContext, targets: readonly Identified[]): Provenance {
  const unit = ctx.unit;
  if (unit === undefined) throw new Error("v2ToFhir runs after the store, where every row has its unit");
  return {
    resourceType: "Provenance",
    id: provenanceId(unit),
    recorded: unit.createdAt.toISOString(),
    agent: [{ who: { display: "Interbox" } }],
    target: targets.map((resource) => ({ reference: `${resource.resourceType}/${resource.id}` })),
  };
}

async function resourcesWithProvenance(msg: HL7v2Message, ctx: RowContext): Promise<Resource[]> {
  const resources = await convertToFhir(msg, ctx);
  const targets = resources.filter(isIdentified);
  return targets.length === 0 ? resources : [...resources, provenanceOf(ctx, targets)];
}

export const v2ToFhir = defineStep("v2-to-fhir", (msgs: Batch<HL7v2Message>) => msgs.flatMap(resourcesWithProvenance));
