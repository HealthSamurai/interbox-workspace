import { expect, test } from "bun:test";
import { Rng } from "../src/gen/rng.ts";

test("same seed -> same sequence (deterministic)", () => {
  const a = new Rng(42), b = new Rng(42);
  expect([a.int(1000), a.int(1000), a.int(1000)]).toEqual([b.int(1000), b.int(1000), b.int(1000)]);
});
test("pick returns an element; weighted favours heavy option", () => {
  const r = new Rng(7);
  expect(["x", "y"]).toContain(r.pick(["x", "y"]));
  let heavy = 0;
  for (let i = 0; i < 1000; i++) if (r.weighted([["A", 9], ["B", 1]]) === "A") heavy++;
  expect(heavy).toBeGreaterThan(800);
});
test("exponential inter-arrivals: positive, deterministic, mean ~ 1/rate", () => {
  expect(new Rng(7).exponential(5)).toBe(new Rng(7).exponential(5));
  const r = new Rng(123);
  let sum = 0;
  for (let i = 0; i < 20000; i++) sum += r.exponential(10);
  const mean = sum / 20000; // expect ~0.1s for rate=10/s
  expect(mean).toBeGreaterThan(0.095);
  expect(mean).toBeLessThan(0.105);
});
