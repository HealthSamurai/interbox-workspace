import { expect, test } from "bun:test";
import { generateMessage } from "../src/gen/assemble.ts";
import { Rng } from "../src/gen/rng.ts";
import { fakerNames } from "../src/gen/names.ts";
import type { Profile } from "../src/profile/schema.ts";
import prof from "../fixtures/profile.json";

const profile = prof as unknown as Profile;

// Collect ORU messages (the only type that carries OBX/NTE) from a spread of seeds.
function oruMessages(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const { msg } = generateMessage(new Rng(100 + i), profile, fakerNames("en", 1), i);
    if (msg.split("\r").some((s) => s.startsWith("OBR|"))) out.push(msg);
  }
  return out;
}

test("some ORU OBX carry NTE notes (real vendor ORU have them; generator used to emit none)", () => {
  const orus = oruMessages(120);
  expect(orus.length).toBeGreaterThan(0);
  const withNte = orus.filter((m) => m.split("\r").some((s) => s.startsWith("NTE|")));
  expect(withNte.length).toBeGreaterThan(0);
});

test("every NTE immediately follows an OBX and is well-formed NTE|1|L|<comment>", () => {
  for (const msg of oruMessages(120)) {
    const segs = msg.split("\r");
    segs.forEach((s, i) => {
      if (!s.startsWith("NTE|")) return;
      // The mapper folds an NTE into the note of its preceding OBX — so it must follow one.
      expect(segs[i - 1]?.startsWith("OBX|")).toBe(true);
      const f = s.split("|");
      expect(f[1]).toBe("1"); // NTE-1 set id
      expect(f[2]).toBe("L"); // NTE-2 source (filler/lab)
      expect((f[3] ?? "").length).toBeGreaterThan(0); // NTE-3 comment present
    });
  }
});

test("NTE emission is deterministic per seed", () => {
  const a = generateMessage(new Rng(7), profile, fakerNames("en", 1), 0).msg;
  const b = generateMessage(new Rng(7), profile, fakerNames("en", 1), 0).msg;
  expect(a).toBe(b);
});
