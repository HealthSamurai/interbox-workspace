import { expect, test } from "bun:test";
import { FAULTS, applyFault } from "../src/gen/faults.ts";

const VALID = "MSH|^~\\&|APP|LAB1|RCV|RFAC|20250101||ADT^A01|C1|P|2.5\rPID|1||M1^^^O^MR||LEE^AMY||19900101|F";

test("each fault is registered with a kind and mutates the message", () => {
  expect(FAULTS.length).toBeGreaterThanOrEqual(8);
  for (const f of FAULTS) {
    const out = applyFault(VALID, f.id);
    expect(out).not.toBe(VALID);
    expect(typeof f.intendedKind).toBe("string");
  }
});
test("dropSegment(PID) removes PID; unknownType rewrites MSH-9", () => {
  expect(applyFault(VALID, "no_pid").includes("\rPID|")).toBe(false);
  expect(applyFault(VALID, "unknown_type").includes("ZZZ^Z99")).toBe(true);
});
