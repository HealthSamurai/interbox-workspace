import { expect, test } from "bun:test";
import { classify } from "../src/validate/classify.ts";
import { applyFault, FAULTS } from "../src/gen/faults.ts";

const KNOWN = new Set(["ADT^A01", "ADT^A03"]);
const VALID = "MSH|^~\\&|APP|LAB1|RCV|RFAC|20250101||ADT^A01|C1|P|2.5\rPID|1||M1^^^O^MR||LEE^AMY||19900101|F";

test("valid message classifies as ok", () => {
  expect(classify(VALID, KNOWN).kind).toBe("ok");
});
test("structural faults -> parse_error", () => {
  // Only no_msh truly throws with the real parser; truncated and bad_encoding_chars
  // are lenient-parsed and produce map_error (reality wins).
  for (const id of ["no_msh"]) {
    expect(classify(applyFault(VALID, id), KNOWN).kind).toBe("parse_error");
  }
});
test("truncated -> map_error (parser is lenient)", () => {
  expect(classify(applyFault(VALID, "truncated"), KNOWN).kind).toBe("map_error");
});
test("bad_encoding_chars -> map_error (parser is lenient)", () => {
  expect(classify(applyFault(VALID, "bad_encoding_chars"), KNOWN).kind).toBe("map_error");
});
test("semantic faults -> map_error", () => {
  for (const id of ["unknown_type", "missing_patient_id"]) {
    expect(classify(applyFault(VALID, id), KNOWN).kind).toBe("map_error");
  }
});
test("every fault's intendedKind matches classify output", () => {
  for (const f of FAULTS) {
    const result = classify(applyFault(VALID, f.id), KNOWN);
    expect(result.kind as string, `fault ${f.id}: intendedKind=${f.intendedKind} actual=${result.kind}`).toBe(f.intendedKind);
  }
});
