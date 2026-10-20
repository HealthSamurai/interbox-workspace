import { expect, test } from "bun:test";
import { join } from "node:path";

const COMPOSE_FILE = join(import.meta.dir, "..", "docker-compose.yaml");
const SERVICE = "interbox";
const GRACE_VAR = "INTERBOX_STOP_GRACE_MS";
const ENGINE_DEFAULT_GRACE_MS = 10_000;
const ENGINE_STOP_OVERHEAD_MS = 5_000;
const INTERPOLATION = /^\$\{(\w+)(?::?-(.*))?\}$/;
const DURATION_PART = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/gy;
const MS_PER_UNIT: Readonly<Record<string, number>> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

interface ComposeService {
  readonly stop_grace_period?: unknown;
  readonly environment?: Record<string, unknown> | string[];
}

interface ComposeFile {
  readonly services?: Readonly<Record<string, ComposeService>>;
}

async function interboxService(): Promise<ComposeService> {
  const compose = Bun.YAML.parse(await Bun.file(COMPOSE_FILE).text()) as ComposeFile;
  const service = compose.services?.[SERVICE];
  if (service === undefined) throw new Error(`docker-compose.yaml has no ${SERVICE} service`);
  return service;
}

function withComposeDefault(value: string): string {
  const interpolated = INTERPOLATION.exec(value);
  if (interpolated === null) return value;
  const [, name, fallback] = interpolated;
  if (fallback === undefined) throw new Error(`\${${name}} has no default in docker-compose.yaml, so its value comes from .env`);
  return fallback;
}

function passedThrough(name: string): string {
  return `\${${name}}`;
}

function environmentOf(service: ComposeService): Record<string, string> {
  const { environment } = service;
  if (environment === undefined) return {};
  if (Array.isArray(environment)) {
    return Object.fromEntries(
      environment.map((line) => {
        const at = line.indexOf("=");
        return at === -1 ? [line, passedThrough(line)] : [line.slice(0, at), line.slice(at + 1)];
      }),
    );
  }
  return Object.fromEntries(
    Object.entries(environment).map(([name, value]) => [name, value === null ? passedThrough(name) : String(value)]),
  );
}

function engineGraceMs(service: ComposeService): number {
  const raw = environmentOf(service)[GRACE_VAR];
  if (raw === undefined) return ENGINE_DEFAULT_GRACE_MS;
  const graceMs = Number(withComposeDefault(raw));
  if (!Number.isInteger(graceMs) || graceMs < 0) throw new Error(`${GRACE_VAR} is ${raw}, not a whole number of milliseconds`);
  return graceMs;
}

function durationMs(text: string): number {
  const parts = [...text.matchAll(DURATION_PART)];
  if (parts.length === 0 || parts.map(([part]) => part).join("") !== text) {
    throw new Error(`"${text}" is not a compose duration such as 15s or 1m30s`);
  }
  return parts.reduce((total, [, amount, unit]) => total + Number(amount) * MS_PER_UNIT[unit!]!, 0);
}

function stopGracePeriodMs(service: ComposeService): number {
  const { stop_grace_period: period } = service;
  if (period === undefined) throw new Error(`the ${SERVICE} service sets no stop_grace_period`);
  if (typeof period !== "string") throw new Error(`stop_grace_period is ${String(period)}, not a duration such as 20s`);
  return durationMs(withComposeDefault(period));
}

test("the interbox service sets a stop_grace_period", async () => {
  expect((await interboxService()).stop_grace_period).toBeDefined();
});

test("its stop_grace_period outlasts INTERBOX_STOP_GRACE_MS by at least 5 s, with the compose defaults", async () => {
  const service = await interboxService();
  expect(stopGracePeriodMs(service)).toBeGreaterThanOrEqual(engineGraceMs(service) + ENGINE_STOP_OVERHEAD_MS);
});
