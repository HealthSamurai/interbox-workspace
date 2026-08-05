// Send MLLP-framed HL7v2 messages to a listening engine.
//
// Usage: bun run send <mode> [flags]
//   batch    fire a fixed count as fast as the pool allows, then exit
//   stream   emit a continuous paced stream with live timestamps until stopped
//
// `<mode> --help` lists that mode's flags. Run with no args for an overview.
//
// Messages come from the profile-driven generator (src/gen/*) — the same engine
// the UI and `bun run gen` use. Faults are injected at --errorRate from the
// FAULTS table and classified locally so the summary previews how the engine
// will bucket them (parse_error / map_error / data_quality / benign-ok).
import { Rng } from "./gen/rng.ts";
import { fakerNames } from "./gen/names.ts";
import { parseProfile, type Profile } from "./profile/schema.ts";
import { generateMessage } from "./gen/assemble.ts";
import { FAULTS } from "./gen/faults.ts";
import { classify } from "./validate/classify.ts";
import { sendOverMllp, sendOverMllpReliable, streamOverMllp } from "./send/mllp.ts";
import { DEFAULT_PROFILE } from "./paths.ts";

// --- flag spec: one declarative source drives parsing, validation, and help ---
interface Flag {
  name: string;
  type: "number" | "string" | "boolean";
  /** Default when the flag is omitted; absent → the option is left undefined. */
  def?: number | string | boolean;
  /** Short stand-in for `def` in --help, when the real value is too long to show. */
  defHelp?: string;
  /** Value to use when a number/string flag is passed bare (e.g. `--jitter`). */
  bare?: number | string;
  required?: boolean;
  /** Placeholder shown in help, e.g. `<n>`. */
  meta?: string;
  help: string;
}

const COMMON: Flag[] = [
  { name: "errorRate", type: "number", def: 0.1, meta: "<f>", help: "fault fraction, 0..1" },
  { name: "seed", type: "number", def: 42, meta: "<n>", help: "RNG seed (deterministic content)" },
  { name: "profile", type: "string", def: DEFAULT_PROFILE, defHelp: "the bundled fixtures/profile.json", meta: "<path>", help: "generator profile" },
  { name: "host", type: "string", def: "127.0.0.1", meta: "<host>", help: "target host" },
  { name: "port", type: "number", def: 2575, meta: "<port>", help: "target port" },
];

const MODES: Record<string, { summary: string; flags: Flag[]; examples: string[] }> = {
  batch: {
    summary: "fire a fixed count as fast as the pool allows, then exit",
    flags: [
      { name: "count", type: "number", def: 1, meta: "<n>", help: "total messages to send" },
      {
        name: "months",
        type: "number",
        def: 1,
        meta: "<n>",
        help: "spread send_time (MSH-7) uniformly over the last N months",
      },
      { name: "reliable", type: "boolean", def: false, help: "wait for each ACK (AA) and retry on failure" },
      ...COMMON,
    ],
    examples: ["batch --count 500 --months 3", "batch --count 50 --errorRate 0.3 --reliable"],
  },
  stream: {
    summary: "emit a continuous paced stream with live timestamps until stopped",
    flags: [
      { name: "rate", type: "number", required: true, meta: "<msg/s>", help: "target send rate" },
      {
        name: "duration",
        type: "number",
        meta: "<s>",
        help: "stop after S seconds (default: run until Ctrl-C)",
      },
      {
        name: "jitter",
        type: "number",
        def: 0,
        bare: 0.5,
        meta: "[=frac]",
        help: "randomize fixed inter-arrival by ±frac (bare --jitter = 0.5)",
      },
      { name: "poisson", type: "boolean", def: false, help: "exponential inter-arrival (Poisson) instead of fixed; overrides --jitter" },
      ...COMMON,
    ],
    examples: ["stream --rate 5", "stream --rate 20 --duration 120 --poisson --errorRate 0.2"],
  },
};

const SELF = "bun run send";

function die(msg: string, mode?: string): never {
  console.error(`error: ${msg}`);
  console.error(mode ? `try \`${SELF} ${mode} --help\`` : `try \`${SELF} --help\``);
  process.exit(1);
}

function generalHelp(): void {
  console.log("send — send MLLP-framed HL7v2 messages to a listening engine\n");
  console.log(`Usage: ${SELF} <mode> [flags]\n`);
  console.log("Modes:");
  for (const [name, m] of Object.entries(MODES)) console.log(`  ${name.padEnd(8)} ${m.summary}`);
  console.log(`\nRun \`${SELF} <mode> --help\` for a mode's flags.\n`);
  console.log("Examples:");
  for (const m of Object.values(MODES)) for (const ex of m.examples) console.log(`  ${SELF} ${ex}`);
}

function modeHelp(mode: string): void {
  const m = MODES[mode]!;
  console.log(`send ${mode} — ${m.summary}\n`);
  console.log(`Usage: ${SELF} ${mode} [flags]\n`);
  console.log("Flags:");
  for (const f of m.flags) {
    const usage = `--${f.name}${f.meta ? ` ${f.meta}` : ""}`;
    const note = f.required ? "(required)" : f.def !== undefined ? `(default ${f.defHelp ?? f.def})` : "(optional)";
    console.log(`  ${usage.padEnd(20)} ${f.help} ${note}`);
  }
  console.log("\nExamples:");
  for (const ex of m.examples) console.log(`  ${SELF} ${ex}`);
}

type Opts = Record<string, number | string | boolean>;

/** Parse argv against a mode's flag spec; reject unknown/invalid/missing flags. */
function parseMode(mode: string, argv: string[]): Opts {
  const spec = MODES[mode]!;
  const byName = new Map(spec.flags.map((f) => [f.name, f]));
  const values: Opts = {};
  for (const f of spec.flags) if (f.def !== undefined) values[f.name] = f.def;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") {
      modeHelp(mode);
      process.exit(0);
    }
    if (!a.startsWith("--")) die(`unexpected argument '${a}' — flags start with '--'`, mode);
    const eq = a.indexOf("=");
    const key = eq >= 0 ? a.slice(2, eq) : a.slice(2);
    const f = byName.get(key);
    if (!f) {
      die(`unknown flag '--${key}' for mode '${mode}' (valid: ${[...byName.keys()].join(", ")})`, mode);
    }
    if (f.type === "boolean") {
      if (eq >= 0) die(`flag '--${key}' is a boolean and takes no value`, mode);
      values[f.name] = true;
      continue;
    }
    let raw: string | undefined = eq >= 0 ? a.slice(eq + 1) : undefined;
    if (raw === undefined) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        raw = next;
        i++;
      } else if (f.bare !== undefined) {
        values[f.name] = f.bare;
        continue;
      } else {
        die(`flag '--${key}' needs a value`, mode);
      }
    }
    if (f.type === "string") {
      values[f.name] = raw;
    } else {
      const n = Number(raw);
      if (!Number.isFinite(n)) die(`--${key} expects a number, got '${raw}'`, mode);
      values[f.name] = n;
    }
  }
  for (const f of spec.flags) {
    if (f.required && values[f.name] === undefined) die(`mode '${mode}' requires --${f.name}`, mode);
  }
  return values;
}

// --- shared generation: profile-driven content + fault injection + tally ---
interface Generator {
  /** Build the next wire message; `now` pins MSH-7 (batch spread / live stream). */
  gen: (now?: Date) => string;
  summary: () => { injected: number; byKind: Map<string, number> };
}

async function buildGenerator(profilePath: string, seed: number, errorRate: number): Promise<Generator> {
  let profile: Profile;
  try {
    profile = parseProfile(await Bun.file(profilePath).text());
  } catch (e) {
    die(`could not read profile '${profilePath}': ${(e as Error)?.message ?? e}`);
  }
  const knownTypes = new Set(profile.messageTypes.map(([t]) => t));
  const rng = new Rng(seed);
  const names = fakerNames("en", seed);
  let index = 0;
  let injected = 0;
  const byKind = new Map<string, number>();

  const gen = (now?: Date): string => {
    let msg = generateMessage(rng, profile, names, index++, { now }).msg;
    // Roll a fault after the message is built so the RNG stream (and thus the
    // content) is identical whether or not a fault lands — only the corruption
    // differs. Mirrors src/cli.ts. We send the wire bytes regardless; the engine
    // does the authoritative classification, this tally is just a preview.
    if (errorRate > 0 && rng.next() < errorRate) {
      msg = rng.pick(FAULTS).apply(msg);
      injected++;
      const kind = classify(msg, knownTypes).kind;
      byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
    }
    return msg;
  };
  return { gen, summary: () => ({ injected, byKind }) };
}

function printFaultSummary(g: Generator, total: number): void {
  const { injected, byKind } = g.summary();
  if (injected === 0) return;
  const breakdown = [...byKind.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}=${n}`)
    .join(" ");
  const pct = total > 0 ? ((injected / total) * 100).toFixed(1) : "0.0";
  // "ok" here = a fault that classifies benign (e.g. future DOB) — engine keeps it.
  console.log(`injected ${injected} faults (${pct}%): ${breakdown}`);
}

// --- batch mode: fixed count, MSH-7 spread over [now - months, now], conn pool ---
async function runBatch(opts: Opts): Promise<void> {
  const host = opts.host as string;
  const port = opts.port as number;
  const count = opts.count as number;
  const months = opts.months as number;
  const reliable = opts.reliable as boolean;
  if (!(count > 0)) die(`--count must be > 0, got ${count}`, "batch");

  const g = await buildGenerator(opts.profile as string, opts.seed as number, opts.errorRate as number);

  // send_time (MSH-7) window: [now - N months, now], messages evenly spaced so
  // the distribution is uniform across the span — each calendar month gets
  // ~count/N. Deterministic: message i lands at the center of its slot.
  const windowEnd = Date.now();
  const windowStart = (() => {
    const d = new Date(windowEnd);
    d.setMonth(d.getMonth() - months);
    return d.getTime();
  })();
  const slotMs = (windowEnd - windowStart) / count;
  const messages = Array.from({ length: count }, (_, i) => g.gen(new Date(windowStart + (i + 0.5) * slotMs)));

  console.log(
    `spreading ${count} msgs over ${months} month(s): ` +
      `${new Date(windowStart).toISOString()} .. ${new Date(windowEnd).toISOString()} ` +
      `(${(slotMs / 1000).toFixed(2)}s/msg)`,
  );

  const t0 = Date.now();
  if (reliable) {
    const r = await sendOverMllpReliable(messages, { host, port });
    const dt = (Date.now() - t0) / 1000;
    console.log(
      `done: acked ${r.acked}, failed ${r.failed}, retries ${r.retries} in ${dt.toFixed(2)}s ` +
        `(${(r.acked / dt).toFixed(0)} msg/s) to ${host}:${port}`,
    );
  } else {
    const sent = await sendOverMllp(messages, { host, port });
    const dt = (Date.now() - t0) / 1000;
    console.log(`done: sent ${sent} msgs in ${dt.toFixed(2)}s (${(sent / dt).toFixed(0)} msg/s) to ${host}:${port}`);
  }
  printFaultSummary(g, count);
}

// --- stream mode: paced, live-timestamped, runs until Ctrl-C or --duration ---
async function runStream(opts: Opts): Promise<void> {
  const host = opts.host as string;
  const port = opts.port as number;
  const rate = opts.rate as number;
  if (!(rate > 0)) die(`--rate must be > 0, got ${rate}`, "stream");
  const duration = opts.duration as number | undefined;
  const jitter = opts.jitter as number;
  const poisson = opts.poisson as boolean;

  const g = await buildGenerator(opts.profile as string, opts.seed as number, opts.errorRate as number);

  const intervalMs = 1000 / rate;
  // Inter-arrival gap model: Poisson (exponential) is the realistic feed cadence;
  // otherwise a fixed interval, optionally jittered ±frac for organic pacing.
  const gapMs = poisson
    ? (): number => (-Math.log(1 - Math.random()) / rate) * 1000
    : jitter
      ? (): number => intervalMs * (1 - jitter + 2 * jitter * Math.random())
      : (): number => intervalMs;

  const ac = new AbortController();
  const stop = (): void => ac.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const durTimer = duration ? setTimeout(stop, duration * 1000) : undefined;

  const pacing = poisson ? "Poisson" : jitter ? `jitter ±${Math.round(jitter * 100)}%` : "even";
  console.log(
    `streaming ~${rate} msg/s` +
      (duration ? ` for ${duration}s` : " (Ctrl-C to stop)") +
      `, ${pacing} → ${host}:${port} (errorRate ${opts.errorRate})`,
  );

  const t0 = Date.now();
  let lastLog = t0;
  const sent = await streamOverMllp({
    host,
    port,
    reconnect: true, // survive an engine restart mid-demo
    signal: ac.signal,
    next: () => g.gen(new Date()), // live MSH-7 = wall-clock send time
    gapMs,
    onSent: (n) => {
      const now = Date.now();
      if (now - lastLog >= 5000) {
        const secs = (now - t0) / 1000;
        console.log(`streamed ${n} msgs in ${secs.toFixed(0)}s (~${(n / secs).toFixed(1)} msg/s)`);
        lastLog = now;
      }
    },
  });

  if (durTimer) clearTimeout(durTimer);
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  const dt = (Date.now() - t0) / 1000;
  console.log(`\nstopped: streamed ${sent} msgs in ${dt.toFixed(1)}s (~${(sent / dt).toFixed(1)} msg/s)`);
  printFaultSummary(g, sent);
}

// --- dispatch ---
const [mode, ...rest] = process.argv.slice(2);

if (mode === undefined || mode === "help" || mode === "--help" || mode === "-h") {
  generalHelp();
  process.exit(0);
}
if (!(mode in MODES)) {
  const hint = /^\d/.test(mode) ? ` (positional args are gone — did you mean \`batch --count ${mode}\`?)` : "";
  console.error(`error: unknown mode '${mode}'${hint}\n`);
  generalHelp();
  process.exit(1);
}

const opts = parseMode(mode, rest);
if (mode === "batch") await runBatch(opts);
else await runStream(opts);
