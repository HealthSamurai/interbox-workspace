// Determinism is what this tool sells: a seed must reproduce a corpus.
//
// Every other determinism check in the suite compares two runs in the SAME
// process at the SAME commit, which cannot catch a change to the PRNG itself.
// The golden vector below can: change the mulberry32 constants in src/gen/rng.ts
// and this fails, instead of every previously-generated corpus silently becoming
// irreproducible.
import { expect, test } from "bun:test";
import { Rng } from "../src/gen/rng.ts";
import { makeGenerator } from "../src/gen/stream.ts";
import { parseProfile } from "../src/profile/schema.ts";
import { DEFAULT_PROFILE } from "../src/paths.ts";

const profile = parseProfile(await Bun.file(DEFAULT_PROFILE).text());

test("Rng golden vector — seed 42 draws a fixed sequence", () => {
  const r = new Rng(42);
  expect([r.int(1000), r.int(1000), r.int(1000), r.int(1000), r.int(1000)])
    .toEqual([601, 448, 852, 669, 174]);
});

test("Rng.next golden vector", () => {
  const r = new Rng(7);
  const first = [r.next(), r.next(), r.next()].map((n) => Number(n.toFixed(12)));
  expect(first).toEqual([0.011704753153, 0.061958257575, 0.976907632779]);
});

test("pick and weighted reject empty distributions instead of yielding undefined", () => {
  const r = new Rng(1);
  expect(() => r.pick([])).toThrow(/empty/);
  expect(() => r.weighted([])).toThrow(/empty/);
});

test("same seed reproduces a whole message sequence, not just one message", () => {
  const run = (): string[] => {
    const next = makeGenerator({ profile, seed: 99 });
    return Array.from({ length: 50 }, () => next(0).msg);
  };
  expect(run()).toEqual(run());
});

test("faults are seeded too — same seed, same corruptions", () => {
  const run = (): { msg: string; injected: boolean }[] => {
    const next = makeGenerator({ profile, seed: 5 });
    return Array.from({ length: 40 }, () => {
      const m = next(0.5);
      return { msg: m.msg, injected: m.injected };
    });
  };
  const a = run();
  const b = run();
  expect(a).toEqual(b);
  // Guard against the assertion passing vacuously: at 0.5 over 40 messages,
  // some faults must have landed.
  expect(a.some((m) => m.injected)).toBe(true);
});

test("a different seed produces different traffic", () => {
  const first = makeGenerator({ profile, seed: 1 })(0).msg;
  const second = makeGenerator({ profile, seed: 2 })(0).msg;
  expect(first).not.toBe(second);
});

test("forced types round-robin evenly regardless of profile weights", () => {
  const next = makeGenerator({ profile, seed: 3, types: ["ADT^A01", "ORU^R01"] });
  const types = Array.from({ length: 10 }, () => next(0).type);
  expect(types.filter((t) => t === "ADT").length).toBe(5);
  expect(types.filter((t) => t === "ORU").length).toBe(5);
});

test("startIndex shifts the identifier sequence so a restart does not replay IDs", () => {
  const fresh = makeGenerator({ profile, seed: 11 });
  const firstTwo = [fresh(0).msg, fresh(0).msg];
  const resumed = makeGenerator({ profile, seed: 11, startIndex: 2 });
  expect(firstTwo).not.toContain(resumed(0).msg);
});
