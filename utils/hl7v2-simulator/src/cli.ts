import { join } from "node:path";
import { mkdir, rm, readdir } from "node:fs/promises";
import { Rng } from "./gen/rng.ts";
import { fakerNames } from "./gen/names.ts";
import { parseProfile } from "./profile/schema.ts";
import { generateMessage } from "./gen/assemble.ts";
import { FAULTS } from "./gen/faults.ts";
import { classify } from "./validate/classify.ts";
import { toRow, type MessageRow } from "./gen/row.ts";
import { DEFAULT_PROFILE } from "./paths.ts";

// usage: bun run src/cli.ts <count> <faultRate 0..1> <seed>
//   [--profile f.json]   (default fixtures/profile.json)
//   [--output csv|jsonl] (write out.csv / out.jsonl)
//   [--out-dir dir]      (write one .hl7 file per message into dir — for folder/batch ingest)
//   [--types A,B,C]      (force an exact message-type mix, equal weights; default = profile mix)
//   [--clean]            (with --out-dir: delete existing files in dir first)
//   [--locale en|de]
//
// To send generated traffic over MLLP, use the sender CLI: `bun run send`
// (src/send-cli.ts) — batch + live stream modes.
//
// Content comes ENTIRELY from the profile (aggregate distributions) + synthetic
// identity — no real data is read at generation time.
const args = process.argv.slice(2);
const count = Number(args[0] ?? 1000);
const faultRate = Number(args[1] ?? 0.1);
const seed = Number(args[2] ?? 42);
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const outFmt = flag("--output");
const profilePath = flag("--profile") ?? DEFAULT_PROFILE;
const channel = flag("--channel") ?? "mllp-default";
const outDir = flag("--out-dir");
const doClean = args.includes("--clean");
const typesArg = flag("--types");
const localeArg = flag("--locale") ?? "en";
if (localeArg !== "en" && localeArg !== "de") {
  console.error(`--locale must be "en" or "de", got: ${localeArg}`);
  process.exit(1);
}
const locale = localeArg as "en" | "de";

const profile = parseProfile(await Bun.file(profilePath).text());
// Code-mapping demo knobs (override the profile): fraction of ORU using local
// codes, and of those the fraction emitted dual-coded (with the LOINC answer).
const lcr = flag("--local-code-rate"); if (lcr !== undefined) profile.localCodeRate = Number(lcr);
const mr = flag("--mapped-rate"); if (mr !== undefined) profile.mappedRate = Number(mr);
// --types: force a round-robin mix (validated against what the profile knows), so
// every listed type appears — evenly — regardless of the profile's own weights.
const forcedTypes = typesArg ? typesArg.split(",").map((s) => s.trim()).filter(Boolean) : null;
const knownTypes = new Set(profile.messageTypes.map(([t]) => t));
if (forcedTypes) {
  const bad = forcedTypes.filter((t) => !knownTypes.has(t));
  if (bad.length) {
    console.error(`--types: unknown for this profile: ${bad.join(", ")}\navailable: ${[...knownTypes].join(", ")}`);
    process.exit(1);
  }
}
const rng = new Rng(seed);
const names = fakerNames(locale, seed);
const rows: MessageRow[] = [];
const outFiles: { msg: string; type: string }[] = [];

for (let i = 0; i < count; i++) {
  if (forcedTypes) profile.messageTypes = [[forcedTypes[i % forcedTypes.length]!, 1]];
  const gen = generateMessage(rng, profile, names, i);
  let msg = gen.msg;
  // Generated messages are valid + mappable by construction -> received.
  // Only an injected fault can break a message; the engine's parser names the
  // kind (a benign fault may still classify "ok" -> stays received).
  if (rng.next() < faultRate) {
    msg = rng.pick(FAULTS).apply(msg);
    const c = classify(msg, knownTypes);
    if (c.kind !== "ok") {
      rows.push(toRow(msg, "error", channel, { errorKind: c.kind, errorMessage: c.detail }));
      if (outDir) outFiles.push({ msg, type: gen.type });
      continue;
    }
  }
  rows.push(toRow(msg, "received", channel));
  if (outDir) outFiles.push({ msg, type: gen.type });
}

const tally = (key: (r: MessageRow) => string) => {
  const m = new Map<string, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
console.log(`generated ${rows.length} from ${profilePath} (faultRate=${faultRate}, seed=${seed})`);
console.log("by status:", tally((r) => r.status));
console.log("by type:  ", tally((r) => r.message_type ?? "?"));
console.log("by source:", tally((r) => r.source ?? "?"));
console.log("by error: ", tally((r) => r.error_kind ?? "-"));

if (outFmt === "jsonl") {
  await Bun.write("out.jsonl", rows.map((r) => JSON.stringify(r)).join("\n"));
  console.log("wrote out.jsonl");
} else if (outFmt === "csv") {
  const cols = Object.keys(rows[0] ?? {});
  const esc = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => esc((r as unknown as Record<string, unknown>)[c])).join(","))].join("\n");
  await Bun.write("out.csv", csv);
  console.log("wrote out.csv");
}

// Folder/batch output: one raw .hl7 per message (CR-separated segments, no MLLP
// framing), named msg-<NN>-<TYPE>.hl7 — exactly what folderSource/hl7v2Parser drains.
if (outDir) {
  await mkdir(outDir, { recursive: true });
  if (doClean) {
    for (const f of await readdir(outDir)) await rm(join(outDir, f), { force: true });
  }
  const width = String(outFiles.length).length;
  let k = 0;
  for (const { msg, type } of outFiles) {
    k += 1;
    const name = `msg-${String(k).padStart(width, "0")}-${type.replace(/\^/g, "_")}.hl7`;
    await Bun.write(join(outDir, name), msg);
  }
  console.log(`wrote ${outFiles.length} .hl7 files to ${outDir}${doClean ? " (cleaned first)" : ""}`);
}

