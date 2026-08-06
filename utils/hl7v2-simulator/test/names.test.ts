import { expect, test } from "bun:test";
import { fakerNames } from "../src/gen/names.ts";

test("deterministic per seed: same seed -> same first name", () => {
  expect(fakerNames("en", 7).firstName()).toBe(fakerNames("en", 7).firstName());
});
test("produces non-empty names for en and de", () => {
  const en = fakerNames("en", 1);
  expect(en.firstName().length).toBeGreaterThan(0);
  expect(en.lastName().length).toBeGreaterThan(0);
  expect(typeof fakerNames("de", 1).firstName()).toBe("string");
});
