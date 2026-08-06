import { expect, test } from "bun:test";
import { parseProfile } from "../src/profile/schema.ts";
import { generateMessage } from "../src/gen/assemble.ts";
import { Rng } from "../src/gen/rng.ts";
import { fakerNames } from "../src/gen/names.ts";
import { classify } from "../src/validate/classify.ts";
import { fillFormat, sampleNumeric } from "../src/gen/sample/sampler.ts";
import { getField } from "../src/hl7/message.ts";
import type { NumericModel } from "../src/profile/schema.ts";

const profile = parseProfile(await Bun.file(`${import.meta.dir}/../fixtures/profile.example.json`).text());
const knownTypes = new Set(profile.messageTypes.map(([t]) => t));

test("every generated message is parser-valid + unique (example profile)", () => {
  const rng = new Rng(99);
  const names = fakerNames("en", 99);
  const seen = new Set<string>();
  for (let i = 0; i < 300; i++) {
    const { msg } = generateMessage(rng, profile, names, i);
    expect(classify(msg, knownTypes).kind).toBe("ok");
    seen.add(msg);
  }
  expect(seen.size).toBe(300);
});

test("generation is deterministic per seed", () => {
  const a = generateMessage(new Rng(5), profile, fakerNames("en", 5), 0).msg;
  const b = generateMessage(new Rng(5), profile, fakerNames("en", 5), 0).msg;
  expect(a).toBe(b);
});

test("opts.now pins MSH-7 to the given instant (UTC YYYYMMDDHHMMSS)", () => {
  const now = new Date(Date.UTC(2026, 0, 15, 13, 45, 30)); // 2026-01-15T13:45:30Z
  const { msg } = generateMessage(new Rng(7), profile, fakerNames("en", 7), 0, { now });
  expect(getField(msg, "MSH", 7)).toBe("20260115134530");
  // still parser-valid with the injected timestamp
  expect(classify(msg, knownTypes).kind).toBe("ok");
});

test("opts.now=undefined keeps the profile-sampled timestamp path unchanged", () => {
  // Byte-identical to a plain call: the override's short-circuit must not perturb
  // the RNG stream when `now` is absent.
  const a = generateMessage(new Rng(11), profile, fakerNames("en", 11), 0).msg;
  const b = generateMessage(new Rng(11), profile, fakerNames("en", 11), 0, {}).msg;
  expect(b).toBe(a);
});

test("numeric abnormal flag never contradicts the reference range", () => {
  const rng = new Rng(3);
  const model: NumericModel = { kind: "numeric", units: "mmol/L", ref: "136-145", mean: 140, sd: 2.5, min: 120, max: 160, abnormalRate: 0.5 };
  for (let i = 0; i < 500; i++) {
    const { value, flag } = sampleNumeric(rng, model);
    const v = Number(value);
    expect(flag).toBe(v < 136 ? "L" : v > 145 ? "H" : "");
  }
});

test("fillFormat fills # with the index and stays unique per index", () => {
  expect(fillFormat(new Rng(1), "GEN-####", 7)).toBe("GEN-0007");
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) seen.add(fillFormat(new Rng(1), "########", i));
  expect(seen.size).toBe(1000);
});
