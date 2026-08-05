import { createHash } from "node:crypto";
import { getComponent, getField } from "../hl7/message.ts";

/** One generated message flattened into columns — the shape `--output csv|jsonl` writes. */
export interface MessageRow {
  message_hash: string; status: string; channel: string; source: string | null;
  message_type: string | null; event_type: string | null;
  patient_id: string | null; patient_name: string | null;
  message: string; error_kind: string | null; error_message: string | null;
}

function messageHash(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function toRow(
  msg: string, status: string, channel: string,
  err?: { errorKind?: string; errorMessage?: string },
): MessageRow {
  const pid5 = getField(msg, "PID", 5);
  const name = [getComponent(pid5, 2), getComponent(pid5, 1)].filter(Boolean).join(" ").trim() || null;
  return {
    message_hash: messageHash(msg),
    status,
    // Protocol source these messages would arrive on. This tool emits HL7v2 bound
    // for MLLP, so the default names the MLLP listener.
    channel,
    source: getComponent(getField(msg, "MSH", 4), 1) || null,
    message_type: getComponent(getField(msg, "MSH", 9), 1) || null,
    event_type: getComponent(getField(msg, "MSH", 9), 2) || null,
    patient_id: getComponent(getField(msg, "PID", 3), 1) || null,
    patient_name: name,
    message: msg,
    error_kind: err?.errorKind ?? null,
    error_message: err?.errorMessage ?? null,
  };
}
