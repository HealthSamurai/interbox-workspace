/**
 * Send documents from the terminal.
 *
 * The window is the better tool for looking at one document; this is for the
 * other job — pushing a whole directory through the engine and finding out what
 * it does with it. It prints one line per document and a tally at the end.
 *
 *   bun run src/send-cli.ts --group Samples --limit 10
 *   bun run src/send-cli.ts --endpoint http://localhost:2880/ccda
 */

import { loadConfig } from "./config.ts";
import { scanLibrary, formatBytes, type Sample } from "./library.ts";
import { sendDocument } from "./send.ts";

interface Options {
  group: string | null;
  limit: number;
  endpoint: string | null;
  pauseMs: number;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { group: null, limit: Infinity, endpoint: null, pauseMs: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    switch (arg) {
      case "--group": opts.group = value ?? null; i += 1; break;
      // `|| Infinity` would turn `--limit 0` and a typo'd `--limit abc` into "no
      // limit at all", which posts the whole library to the engine. A number that
      // parses is used as given; one that does not leaves the default.
      case "--limit": {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0) opts.limit = n;
        i += 1;
        break;
      }
      case "--endpoint": opts.endpoint = value ?? null; i += 1; break;
      case "--pause": opts.pauseMs = Number(value ?? "0") || 0; i += 1; break;
      case "--help":
        console.log("usage: send-cli [--group NAME] [--limit N] [--endpoint URL] [--pause MS]");
        process.exit(0);
        break;
      default:
        if (arg?.startsWith("--")) {
          console.error(`Unknown option ${arg}. Try --help.`);
          process.exit(2);
        }
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const config = loadConfig();

if (config.problem) {
  console.error(config.problem);
  process.exit(1);
}

const library = scanLibrary(config.roots);
const endpoint = opts.endpoint ?? config.endpoint;

const chosen: Sample[] = [];
for (const group of library.groups) {
  if (group.error) console.error(`${group.label}: ${group.error}`);
  if (opts.group && !group.label.toLowerCase().includes(opts.group.toLowerCase())) continue;
  for (const sample of group.samples) {
    if (chosen.length >= opts.limit) break;
    chosen.push(sample);
  }
}

if (chosen.length === 0) {
  // `--limit 0` is a request for nothing, and it was satisfied. Reporting an
  // empty library would be untrue, and exiting non-zero would fail a run that
  // did exactly what it was asked.
  if (opts.limit === 0) {
    console.log("--limit 0: nothing to send.");
    process.exit(0);
  }
  console.error(opts.group ? `Nothing matches --group ${opts.group}.` : "The library is empty.");
  process.exit(1);
}

console.log(`${chosen.length} document(s) → ${endpoint}\n`);

let accepted = 0;
let rejected = 0;
let unreachable = 0;

for (const [i, sample] of chosen.entries()) {
  const res = await sendDocument(sample.path, endpoint, { name: sample.file });
  const n = String(i + 1).padStart(String(chosen.length).length, " ");
  const outcome = res.transportError
    ? `— ${res.transportError}`
    : `${res.status} ${res.statusText}`.trim();
  console.log(`${n}/${chosen.length}  ${outcome.padEnd(16)} ${String(Math.round(res.ms)).padStart(6)} ms  ${formatBytes(sample.bytes).padStart(9)}  ${sample.group}/${sample.file}`);

  if (res.transportError) unreachable += 1;
  else if (res.ok) accepted += 1;
  else rejected += 1;

  if (opts.pauseMs > 0 && i < chosen.length - 1) await Bun.sleep(opts.pauseMs);
}

console.log(`\naccepted ${accepted} · rejected ${rejected} · unreachable ${unreachable}`);
// A success answer says the document was queued, not that it converted. What
// became of it is a question for the dashboard.
console.log("Accepted means the engine took the document. Whether it converted is on the Documents page.");
if (unreachable > 0) process.exit(1);
