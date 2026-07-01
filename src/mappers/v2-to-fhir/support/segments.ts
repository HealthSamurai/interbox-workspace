import type {
  HL7v2Message,
  HL7v2Segment,
} from "@healthsamurai/interbox/hl7v2";
import { domainError } from "@healthsamurai/interbox";

export function findSegment(
  message: HL7v2Message,
  name: string,
): HL7v2Segment | undefined {
  return message.find((s) => s.segment === name);
}

export function findAllSegments(
  message: HL7v2Message,
  name: string,
): HL7v2Segment[] {
  return message.filter((s) => s.segment === name);
}

/**
 * Return the PID segment or throw.
 *
 * A segment named "PID*1*..." (startsWith "PID" but not exactly "PID") means
 * the segment is there but its field separators are broken — distinct
 * failure (structure/malformed_pid) from no PID at all (structure/missing_pid).
 */
export function requirePid(msg: HL7v2Segment[]): HL7v2Segment {
  const pid = findSegment(msg, "PID");
  if (pid) {
    return pid;
  }

  const malformed = msg.find(
    (s) => s.segment !== "PID" && s.segment.startsWith("PID"),
  );
  if (malformed) {
    throw domainError(
      "structure",
      "malformed_pid",
      `PID segment is malformed: found segment "${malformed.segment}" — field separators appear broken`,
    );
  }

  throw domainError("structure", "missing_pid", "PID segment not found");
}
