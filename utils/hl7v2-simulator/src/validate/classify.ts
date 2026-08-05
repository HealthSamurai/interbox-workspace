import { parseMessage } from "@atomic-ehr/hl7v2/src/hl7v2/parse";
import { findSegment, getComponent } from "@atomic-ehr/hl7v2/src/hl7v2/types";

export type Kind = "ok" | "parse_error" | "map_error" | "data_quality";
export interface Classification { kind: Kind; detail?: string; }

export function classify(msg: string, knownTypes: ReadonlySet<string>): Classification {
  let parsed;
  try { parsed = parseMessage(msg); }
  catch (e) { return { kind: "parse_error", detail: String(e) }; }
  if (!parsed || parsed.length === 0) return { kind: "parse_error", detail: "empty parse" };
  const msh = findSegment(parsed, "MSH");
  if (!msh) return { kind: "parse_error", detail: "no MSH" };
  const type = getComponent(msh.fields[9], 1);
  const event = getComponent(msh.fields[9], 2);
  if (!knownTypes.has(`${type}^${event}`)) return { kind: "map_error", detail: "no mapper" };
  const pid = findSegment(parsed, "PID");
  const patientId = pid ? getComponent(pid.fields[3], 1) : "";
  if (!patientId) return { kind: "map_error", detail: "no patient id" };
  return { kind: "ok" };
}
