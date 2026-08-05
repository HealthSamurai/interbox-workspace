import { expect, test } from "bun:test";
import { getField, setField, getComponent, segments } from "../src/hl7/message.ts";

const MSG = "MSH|^~\\&|APP|FAC|RCV|RFAC|20260322010925||ADT^A01|CTRL123|P|2.5\rPID|1||MRN42^^^OCC^MR||DOE^JOHN||19800101|M";

test("segments split on CR", () => {
  expect(segments(MSG).map((s) => s.slice(0, 3))).toEqual(["MSH", "PID"]);
});
test("MSH field is off-by-one (MSH-9 = message type)", () => {
  expect(getField(MSG, "MSH", 9)).toBe("ADT^A01");
  expect(getField(MSG, "MSH", 10)).toBe("CTRL123");
});
test("non-MSH field indexing (PID-3, PID-5)", () => {
  expect(getField(MSG, "PID", 3)).toBe("MRN42^^^OCC^MR");
  expect(getComponent(getField(MSG, "PID", 5), 1)).toBe("DOE");
});
test("setField round-trips and is consistent", () => {
  const out = setField(MSG, "MSH", 10, "NEWCTRL");
  expect(getField(out, "MSH", 10)).toBe("NEWCTRL");
  expect(getField(out, "MSH", 9)).toBe("ADT^A01");
});
