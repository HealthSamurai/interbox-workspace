import { getComponent, getField, segments, setField } from "../hl7/message.ts";

export interface Fault {
  id: string;
  intendedKind: string; // hypothesis; VERIFIED against the real parser in Task 9
  apply: (msg: string) => string;
}

const dropSegment = (msg: string, segId: string) =>
  segments(msg).filter((s) => !s.startsWith(segId + "|")).join("\r");

export const FAULTS: Fault[] = [
  { id: "no_msh", intendedKind: "parse_error", apply: (m) => dropSegment(m, "MSH") },
  { id: "bad_encoding_chars", intendedKind: "map_error", apply: (m) => m.replace("|^~\\&|", "|@#$%|") },
  { id: "truncated", intendedKind: "map_error", apply: (m) => m.slice(0, Math.floor(m.length / 2)) },
  { id: "bad_datetime", intendedKind: "ok", apply: (m) => setField(m, "MSH", 7, "20261399ZZ") },
  { id: "no_pid", intendedKind: "map_error", apply: (m) => dropSegment(m, "PID") },
  { id: "unknown_type", intendedKind: "map_error", apply: (m) => setField(m, "MSH", 9, "ZZZ^Z99") },
  { id: "pid_in_z_segment", intendedKind: "map_error", apply: (m) => {
      const mrn = getField(m, "PID", 3);
      return setField(m, "PID", 3, "") + `\rZPI|1|${mrn}`;
    } },
  { id: "missing_patient_id", intendedKind: "map_error", apply: (m) => setField(m, "PID", 3, "") },
  { id: "future_dob", intendedKind: "ok", apply: (m) => setField(m, "PID", 7, "29991231") },
  { id: "pid_in_pid_2", intendedKind: "map_error", apply: (m) => {
      const mrn = getField(m, "PID", 3);
      return setField(setField(m, "PID", 3, ""), "PID", 2, mrn);
    } },
  { id: "mrn_with_subcomponent", intendedKind: "ok", apply: (m) => {
      const pid3 = getField(m, "PID", 3);
      const mrn = getComponent(pid3, 1);
      const rest = pid3.includes("^") ? pid3.slice(pid3.indexOf("^")) : "";
      return setField(m, "PID", 3, `${mrn}&XYZ&ISO${rest}`);
    } },
  { id: "multiple_pid3_repetitions", intendedKind: "ok", apply: (m) => {
      return setField(m, "PID", 3, `${getField(m, "PID", 3)}~M2^^^B^MR`);
    } },
];

export function applyFault(msg: string, id: string): string {
  const f = FAULTS.find((x) => x.id === id);
  if (!f) throw new Error(`unknown fault: ${id}`);
  return f.apply(msg);
}
