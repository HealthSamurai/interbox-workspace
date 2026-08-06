// Foundation self-test: generate from the synthetic profile and prove every
// message is valid per the REAL parser (classify), with correct field extraction
// and no duplicates. No real data involved.
//   bun run src/validate/selftest.ts [count] [seed]
import { parseProfile } from "../profile/schema.ts";
import { generateMessage } from "../gen/assemble.ts";
import { Rng } from "../gen/rng.ts";
import { fakerNames } from "../gen/names.ts";
import { classify, type Kind } from "./classify.ts";
import { toRow } from "../gen/row.ts";
import { DEFAULT_PROFILE } from "../paths.ts";

const N = Number(process.argv[2] ?? 1000);
const seed = Number(process.argv[3] ?? 42);
const profilePath = process.argv[4] ?? DEFAULT_PROFILE;

const profile = parseProfile(await Bun.file(profilePath).text());
const rng = new Rng(seed);
const names = fakerNames("en", seed);
const knownTypes = new Set(profile.messageTypes.map(([t]) => t));

let ok = 0;
const failKinds = new Map<Kind, number>();
const failSample = new Map<Kind, string>();
const byType = new Map<string, number>();
const sources = new Set<string>();
const hashes = new Set<string>();
let missingPatient = 0;
const samples = new Map<string, string>();

for (let i = 0; i < N; i++) {
  const { msg, type, event } = generateMessage(rng, profile, names, i);
  const mt = `${type}^${event}`;
  byType.set(mt, (byType.get(mt) ?? 0) + 1);
  if (!samples.has(mt)) samples.set(mt, msg);

  const c = classify(msg, knownTypes);
  if (c.kind === "ok") ok++;
  else {
    failKinds.set(c.kind, (failKinds.get(c.kind) ?? 0) + 1);
    if (!failSample.has(c.kind)) failSample.set(c.kind, `${c.detail} :: ${msg.replace(/\r/g, " / ").slice(0, 160)}`);
  }

  const row = toRow(msg, "received", "mllp-default");
  if (!row.patient_id || !row.patient_name) missingPatient++;
  if (row.source) sources.add(row.source);
  hashes.add(row.message_hash);
}

console.log(`\n=== self-test: ${N} messages, seed ${seed} ===`);
console.log(`valid (classify ok):   ${ok}/${N}  ${ok === N ? "✓" : "✗ FAIL"}`);
console.log(`unique (no dup hash):  ${hashes.size}/${N}  ${hashes.size === N ? "✓" : "✗ FAIL"}`);
console.log(`patient_id+name set:   ${N - missingPatient}/${N}  ${missingPatient === 0 ? "✓" : "✗ FAIL"}`);
console.log(`distinct sources:      ${[...sources].join(", ")}`);
console.log(`by type:`, Object.fromEntries(byType));
if (failKinds.size) {
  console.log(`\nFAILURES:`);
  for (const [k, n] of failKinds) console.log(`  ${k}: ${n}  e.g. ${failSample.get(k)}`);
}
console.log(`\n--- one sample per type ---`);
for (const [mt, msg] of samples) console.log(`\n[${mt}]\n${msg.replace(/\r/g, "\n")}`);

const pass = ok === N && hashes.size === N && missingPatient === 0;
console.log(`\n${pass ? "PASS ✓" : "FAIL ✗"}`);
process.exit(pass ? 0 : 1);
