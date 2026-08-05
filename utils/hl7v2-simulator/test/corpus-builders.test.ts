import { expect, test } from "bun:test";
import { generateMessage } from "../src/gen/assemble.ts";
import { Rng } from "../src/gen/rng.ts";
import { fakerNames } from "../src/gen/names.ts";
import type { Profile } from "../src/profile/schema.ts";
import prof from "../fixtures/profile.json";
import { SUPPORTED_TYPES } from "../src/gen/grammar/message-types.ts";

const base = prof as unknown as Profile;

function build(mt: string, seed = 7): string[] {
  const p: Profile = { ...base, messageTypes: [[mt, 1]] };
  return generateMessage(new Rng(seed), p, fakerNames("en", 1), 0).msg.split("\r");
}
const skeleton = (segs: string[]): string[] => segs.map((s) => s.split("|")[0]!);

// Skeletons below cover every supported message type.
test("ORM^O01: MSH PID PV1 ORC OBR — new order, no results", () => {
  const segs = build("ORM^O01");
  expect(skeleton(segs)).toEqual(["MSH", "PID", "PV1", "ORC", "OBR"]);
  expect(segs.find((s) => s.startsWith("ORC|"))!.split("|")[1]).toBe("NW");
  expect(segs[0]).toContain("|ORM^O01|");
});

test("MDM^T02: MSH EVN PID PV1 TXA OBX+ — document with ST content lines", () => {
  const segs = build("MDM^T02");
  const sk = skeleton(segs);
  expect(sk.slice(0, 5)).toEqual(["MSH", "EVN", "PID", "PV1", "TXA"]);
  expect(sk.slice(5).every((x) => x === "OBX")).toBe(true);
  expect(sk.filter((x) => x === "OBX").length).toBeGreaterThanOrEqual(2);
  const txa = segs.find((s) => s.startsWith("TXA|"))!;
  expect(txa.split("|")[2]).toMatch(/^\d{5}-\d\^/); // LOINC doc-type code
});

test("RAS^O17: pharmacy administration skeleton", () => {
  const segs = build("RAS^O17");
  expect(skeleton(segs)).toEqual(["MSH", "PID", "PV1", "ORC", "TQ1", "RXE", "RXR", "RXC", "RXA"]);
});

test("RDE^O11 vs RDE^O01 differ per corpus (O01 carries PV2, no TQ1/RXR)", () => {
  expect(skeleton(build("RDE^O11"))).toEqual(["MSH", "PID", "PV1", "ORC", "RXE", "TQ1", "RXR"]);
  expect(skeleton(build("RDE^O01"))).toEqual(["MSH", "PID", "PV1", "PV2", "ORC", "RXE"]);
});

test("registry covers every family the corpora contain", () => {
  for (const t of ["ORU", "ORM", "ADT", "SIU", "MDM", "RAS", "RDE"]) {
    expect(SUPPORTED_TYPES.has(t)).toBe(true);
  }
});
