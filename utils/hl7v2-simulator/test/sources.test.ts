import { expect, test } from "bun:test";
import { generateMessage } from "../src/gen/assemble.ts";
import { Rng } from "../src/gen/rng.ts";
import { fakerNames } from "../src/gen/names.ts";
import type { Profile } from "../src/profile/schema.ts";
import prof from "../fixtures/profile.json";
import { profileFor, normalizeName, slugOf, SourceRegistry, type SourceDef } from "../ui/sources.ts";

const base = prof as unknown as Profile;

const LAB: SourceDef = { id: "sunrise-lab", name: "SUNRISE LAB", type: "lab", rate: 2, faultRate: 0 };
const CLINIC: SourceDef = { id: "cedarview-clinic", name: "CEDARVIEW CLINIC", type: "clinic", rate: 1, faultRate: 0 };

function sample(def: SourceDef, n: number): string[] {
  const p = profileFor(base, def);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(generateMessage(new Rng(500 + i), p, fakerNames("en", 1), i).msg);
  return out;
}

test("name normalization + slug", () => {
  expect(normalizeName("  Sunrise   Lab ")).toBe("SUNRISE LAB");
  expect(slugOf("Sunrise Lab")).toBe("sunrise-lab");
});

test("identity injection: MSH-3/MSH-4 come from the source, not the corpus catalogs", () => {
  for (const msg of sample(LAB, 30)) {
    const msh = msg.split("\r")[0]!.split("|");
    expect(msh[2]).toBe("LAB_IF");        // MSH-3 from type preset
    expect(msh[3]).toBe("SUNRISE LAB");   // MSH-4 from source name
  }
});

test("identity injection: own MRN pool (assigning authority + MRN prefix)", () => {
  for (const msg of sample(LAB, 30)) {
    const pid = msg.split("\r").find((s) => s.startsWith("PID|"));
    if (!pid) continue; // SIU has PID too, but guard anyway
    const cx = pid.split("|")[3]!;        // PID-3 = MRN^^^AA^MR
    expect(cx.split("^")[0]!.startsWith("SL")).toBe(true);
    expect(cx).toContain("^SUNRISE_LAB_MRN^");
  }
});

test("type drives the message mix: lab is ORU-heavy, clinic sends no ORU", () => {
  const oruShare = (msgs: string[]): number =>
    msgs.filter((m) => m.split("\r")[0]!.includes("|ORU^")).length / msgs.length;
  expect(oruShare(sample(LAB, 200))).toBeGreaterThanOrEqual(0.7);
  expect(oruShare(sample(CLINIC, 200))).toBe(0);
});

test("registry: create / update / delete round-trip + persistence across instances", async () => {
  const path = `/tmp/sources-test-${Math.floor(Math.random() * 1e9)}.json`;
  const target = () => ({ host: "127.0.0.1", port: 2510, mock: true });

  const reg = new SourceRegistry(path, target);
  await reg.init(); // seeds 3 defaults
  expect(reg.list().length).toBe(3);

  const def = await reg.create({ name: "Sunrise Lab", type: "lab", rate: 3, targetPort: 2520 });
  expect(def.id).toBe("sunrise-lab");
  expect(reg.targetOf("sunrise-lab")).toEqual({ host: "127.0.0.1", port: 2520 });

  await reg.update("sunrise-lab", { rate: 5, clearTargetPort: true });
  expect(reg.get("sunrise-lab")!.def.rate).toBe(5);
  expect(reg.targetOf("sunrise-lab")).toEqual(target()); // override cleared → global

  // A fresh instance loads the same config from disk.
  const reg2 = new SourceRegistry(path, target);
  await reg2.init();
  expect(reg2.list().map((s) => s.id)).toContain("sunrise-lab");
  expect(reg2.get("sunrise-lab")!.def.rate).toBe(5);

  await reg2.remove("sunrise-lab");
  const reg3 = new SourceRegistry(path, target);
  await reg3.init();
  expect(reg3.list().map((s) => s.id)).not.toContain("sunrise-lab");

  expect(() => reg3.list().length).not.toThrow();
});

test("registry rejects duplicates and bad input", async () => {
  const path = `/tmp/sources-test-${Math.floor(Math.random() * 1e9)}.json`;
  const reg = new SourceRegistry(path, () => ({ host: "127.0.0.1", port: 2510, mock: true }));
  await reg.init();
  await reg.create({ name: "Twin Lab", type: "lab" });
  expect(reg.create({ name: "TWIN LAB", type: "lab" })).rejects.toThrow(/already exists/);
  expect(reg.create({ name: "", type: "lab" })).rejects.toThrow(/name/);
  expect(reg.create({ name: "P Lab", type: "lab", targetPort: 99999 })).rejects.toThrow(/invalid port/);
});

test("actors are independent: stopping one stream does not affect another", async () => {
  const path = `/tmp/sources-test-${Math.floor(Math.random() * 1e9)}.json`;
  // Mock target: the actor loop simulates dispatch without any network.
  const reg = new SourceRegistry(path, () => ({ host: "mock", port: 0, mock: true }));
  await reg.init();
  const a = reg.get("memorial-lab")!.actor;
  const b = reg.get("cedarview-clinic")!.actor;

  a.start(30, 0); // high rates so counters move within ~300ms
  b.start(30, 0);
  await new Promise((r) => setTimeout(r, 300));
  expect(a.snapshot().counters.sent).toBeGreaterThan(0);
  expect(b.snapshot().counters.sent).toBeGreaterThan(0);

  a.stop();
  await new Promise((r) => setTimeout(r, 100)); // let the loop wind down
  const aFrozen = a.snapshot().counters.sent;
  const bBefore = b.snapshot().counters.sent;
  await new Promise((r) => setTimeout(r, 300));
  expect(a.snapshot().counters.sent).toBe(aFrozen);            // stopped → frozen
  expect(b.snapshot().counters.sent).toBeGreaterThan(bBefore); // other one still flows
  b.stop();
});

test("hand-picked msgTypes override the preset mix (equal shares, live via update)", async () => {
  const def: SourceDef = { id: "pick-lab", name: "PICK LAB", type: "lab", rate: 1, faultRate: 0, msgTypes: ["SIU^S12"] };
  const p = profileFor(base, def);
  const types = new Set<string>();
  for (let i = 0; i < 60; i++) {
    const msh = generateMessage(new Rng(900 + i), p, fakerNames("en", 1), i).msg.split("\r")[0]!;
    types.add(msh.split("|")[8]!);
  }
  expect([...types]).toEqual(["SIU^S12"]); // a lab forced to scheduling-only

  const path = `/tmp/sources-test-${Math.floor(Math.random() * 1e9)}.json`;
  const reg = new SourceRegistry(path, () => ({ host: "mock", port: 0, mock: true }));
  await reg.init();
  await reg.update("memorial-lab", { msgTypes: ["ADT^A01", "ORU^R01"] });
  expect(reg.get("memorial-lab")!.def.msgTypes).toEqual(["ADT^A01", "ORU^R01"]);
  await reg.update("memorial-lab", { msgTypes: [] }); // empty = back to preset
  expect(reg.get("memorial-lab")!.def.msgTypes).toBeUndefined();
  expect(reg.update("memorial-lab", { msgTypes: ["FOO^X01"] })).rejects.toThrow(/no valid message types/);
});
