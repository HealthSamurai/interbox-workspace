// toRow defines the CSV/JSONL output contract. A silent column shift here is
// invisible downstream — whatever consumes the corpus just reads the wrong
// field — so pin the extraction against a message with known components.
import { expect, test } from "bun:test";
import { toRow } from "../src/gen/row.ts";

const MSG = [
  "MSH|^~\\&|LAB_IF|SUNRISE LAB|INTERBOX|INTERBOX|20260115093000||ORU^R01|SL-0000000042|P|2.5.1",
  "PID|1||SL00012345^^^SUNRISE_LAB_MRN^MR||DOE^JANE||19800215|F",
  "OBR|1|PL000000042|FL000000042|CBC^COMPLETE BLOOD COUNT^LN",
].join("\r");

test("toRow extracts the MSH/PID components the corpus format promises", () => {
  const r = toRow(MSG, "received", "mllp-default");
  expect(r.status).toBe("received");
  expect(r.channel).toBe("mllp-default");
  expect(r.message_type).toBe("ORU");
  expect(r.source).toBe("SUNRISE LAB"); // MSH-4, the sending facility
  // patient_name is "given family" — the join order is the easy thing to invert.
  expect(r.patient_name).toBe("JANE DOE");
});

test("toRow carries error detail only when the status is error", () => {
  const ok = toRow(MSG, "received", "mllp-default");
  expect(ok.error_kind ?? null).toBeNull();

  const bad = toRow(MSG, "error", "mllp-default", {
    errorKind: "parse_error",
    errorMessage: "unterminated segment",
  });
  expect(bad.status).toBe("error");
  expect(bad.error_kind).toBe("parse_error");
  expect(bad.error_message).toBe("unterminated segment");
});

test("toRow does not throw on a message missing PID", () => {
  const mshOnly = "MSH|^~\\&|A|B|C|D|20260101000000||ADT^A01|X-1|P|2.5.1";
  expect(() => toRow(mshOnly, "received", "mllp-default")).not.toThrow();
});
