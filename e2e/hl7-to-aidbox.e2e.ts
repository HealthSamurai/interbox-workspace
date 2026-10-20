import { expect, test } from "bun:test";
import type { Bundle, Observation, Patient, Resource } from "@health-samurai/interbox/fhir/4.0.1";

const START_BLOCK = "\x0b";
const END_BLOCK = "\x1c\r";
const PIPELINE = "hl7-to-aidbox";
const GLUCOSE = "2345-7";
const POLL_INTERVAL_MS = 1_000;
const ACK_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 10_000;
const TEST_MARGIN_MS = 5_000;
const SETTLED: ReadonlySet<string> = new Set(["sent", "skipped", "error"]);

function fromEnv(name: string, composeDefault: string): string {
  return process.env[name] || composeDefault;
}

const stack = {
  mllpHost: fromEnv("E2E_MLLP_HOST", "localhost"),
  mllpPort: Number(fromEnv("E2E_MLLP_PORT", "2575")),
  aidboxUrl: fromEnv("E2E_AIDBOX_URL", "http://localhost:8080"),
  aidboxClientId: fromEnv("AIDBOX_CLIENT_ID", "root"),
  aidboxClientSecret: fromEnv("AIDBOX_CLIENT_SECRET", "secret"),
  dashboardUrl: fromEnv("INTERBOX_PUBLIC_URL", "http://localhost:3001"),
  timeoutMs: Number(fromEnv("E2E_TIMEOUT_MS", "90000")),
};

const TEST_TIMEOUT_MS = ACK_TIMEOUT_MS + stack.timeoutMs + TEST_MARGIN_MS;

interface Message {
  readonly control: string;
  readonly mrn: string;
  readonly raw: string;
}

interface Msa {
  readonly code: string | undefined;
  readonly control: string | undefined;
}

interface UnitRow {
  readonly id: string;
  readonly status: string;
  readonly attrs: Readonly<Record<string, unknown>>;
  readonly errorKind: string | null;
  readonly errorMessage: string | null;
}

interface PipelineSummary {
  readonly name: string;
}

const run = Date.now().toString(36).toUpperCase();

function hl7Timestamp(at: Date): string {
  return at.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

const sentAt = hl7Timestamp(new Date());

function adtA01(): Message {
  const control = `E2E-ADT-${run}`;
  const mrn = `E2EADT${run}`;
  const raw = [
    `MSH|^~\\&|E2E|E2EFAC|INTERBOX|AIDBOX|${sentAt}||ADT^A01|${control}|P|2.5.1`,
    `EVN|A01|${sentAt}`,
    `PID|1||${mrn}^^^E2EFAC^MR||E2E^ADMIT||19700101|M`,
    `PV1|1|I|WARD1^101^1^E2EFAC${"|".repeat(16)}V${run}`,
  ].join("\r");
  return { control, mrn, raw };
}

function oruR01(): Message {
  const control = `E2E-ORU-${run}`;
  const mrn = `E2EORU${run}`;
  const raw = [
    `MSH|^~\\&|E2E|E2EFAC|INTERBOX|AIDBOX|${sentAt}||ORU^R01|${control}|P|2.5.1`,
    `PID|1||${mrn}^^^E2EFAC^MR||E2E^RESULT||19800101|F`,
    `OBR|1|P${run}|F${run}|${GLUCOSE}^Glucose^LN|||${sentAt}`,
    `OBX|1|NM|${GLUCOSE}^Glucose^LN||95|mg/dL|||||F|||${sentAt}`,
  ].join("\r");
  return { control, mrn, raw };
}

const adt = adtA01();
const oru = oruR01();

async function exchange(message: string): Promise<string> {
  const ack = Promise.withResolvers<string>();
  const noAck = setTimeout(() => {
    ack.reject(new Error(`the MLLP listener at ${stack.mllpHost}:${stack.mllpPort} sent no ACK within ${ACK_TIMEOUT_MS} ms`));
  }, ACK_TIMEOUT_MS);
  let received = "";
  const connecting = Bun.connect({
    hostname: stack.mllpHost,
    port: stack.mllpPort,
    socket: {
      open(socket) {
        socket.write(`${START_BLOCK}${message}${END_BLOCK}`);
      },
      data(_socket, chunk) {
        received += chunk.toString("utf8");
        const end = received.indexOf(END_BLOCK);
        if (end !== -1) ack.resolve(received.slice(received.indexOf(START_BLOCK) + 1, end));
      },
      connectError(_socket, error) {
        ack.reject(error);
      },
      error(_socket, error) {
        ack.reject(error);
      },
      close() {
        ack.reject(new Error("the MLLP listener closed the connection before it answered"));
      },
    },
  });
  try {
    return await ack.promise;
  } finally {
    clearTimeout(noAck);
    void connecting.then((socket) => socket.end(), () => undefined);
  }
}

function once<T>(start: () => Promise<T>): () => Promise<T> {
  let started: Promise<T> | undefined;
  return () => (started ??= start());
}

const adtAck = once(() => exchange(adt.raw));
const oruAck = once(() => exchange(oru.raw));

function msaOf(ack: string): Msa {
  const fields = ack.split("\r").find((segment) => segment.startsWith("MSA|"))?.split("|") ?? [];
  return { code: fields[1], control: fields[2] };
}

async function eventually<T>(
  what: string,
  withinMs: number,
  read: (timeoutMs: number) => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + withinMs;
  const msLeft = (): number => Math.max(0, deadline - Date.now());
  let lastFailure: unknown;
  while (msLeft() > 0) {
    try {
      const value = await read(Math.min(FETCH_TIMEOUT_MS, msLeft()));
      if (value !== undefined) return value;
    } catch (error) {
      lastFailure = error;
    }
    await Bun.sleep(Math.min(POLL_INTERVAL_MS, msLeft()));
  }
  const cause = lastFailure === undefined ? "" : `; the last attempt failed with ${String(lastFailure)}`;
  throw new Error(`${what} did not appear within ${withinMs} ms${cause}`);
}

const isTimeout = (error: unknown): boolean => error instanceof DOMException && error.name === "TimeoutError";

async function getJson<T>(service: string, origin: string, path: string, timeoutMs: number, headers: Record<string, string> = {}): Promise<T> {
  try {
    const response = await fetch(`${origin}${path}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`${service} answered ${response.status} to GET ${path}`);
    return (await response.json()) as T;
  } catch (error) {
    if (isTimeout(error)) throw new Error(`${service} did not answer GET ${path} within ${timeoutMs} ms`);
    throw error;
  }
}

const aidboxAuthorization = `Basic ${btoa(`${stack.aidboxClientId}:${stack.aidboxClientSecret}`)}`;

async function search<R extends Resource>(query: string, timeoutMs: number): Promise<R[]> {
  const bundle = await getJson<Bundle<R>>("Aidbox", stack.aidboxUrl, `/fhir/${query}`, timeoutMs, {
    authorization: aidboxAuthorization,
    accept: "application/fhir+json",
  });
  return (bundle.entry ?? []).flatMap((entry) => (entry.resource === undefined ? [] : [entry.resource]));
}

function patientWithIdentifier(mrn: string, withinMs: number): Promise<Patient> {
  return eventually(`a Patient with the identifier ${mrn} in Aidbox`, withinMs, async (timeoutMs) =>
    (await search<Patient>(`Patient?identifier=${encodeURIComponent(mrn)}`, timeoutMs))[0],
  );
}

function observationOf(patient: Patient, withinMs: number): Promise<Observation> {
  return eventually(`an Observation for Patient/${patient.id} in Aidbox`, withinMs, async (timeoutMs) =>
    (await search<Observation>(`Observation?subject=${encodeURIComponent(`Patient/${patient.id}`)}`, timeoutMs))[0],
  );
}

function dashboardGet<T>(path: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<T> {
  return getJson<T>("the dashboard API", stack.dashboardUrl, path, timeoutMs);
}

function unitsOfPatient(mrn: string): string {
  const filters = JSON.stringify([{ field: "attrs.patient_id", value: mrn }]);
  return `/api/pipelines/${PIPELINE}/units?filters=${encodeURIComponent(filters)}&order=desc&limit=1`;
}

function settledUnitOf(mrn: string, withinMs: number): Promise<UnitRow> {
  return eventually(`a settled ${PIPELINE} unit for patient ${mrn}`, withinMs, async (timeoutMs) => {
    const { rows } = await dashboardGet<{ rows: UnitRow[] }>(unitsOfPatient(mrn), timeoutMs);
    const unit = rows[0];
    return unit !== undefined && SETTLED.has(unit.status) ? unit : undefined;
  });
}

test("the MLLP source acknowledges an ADT^A01 with AA", async () => {
  expect(msaOf(await adtAck())).toEqual({ code: "AA", control: adt.control });
}, TEST_TIMEOUT_MS);

test("the ADT^A01 reaches Aidbox as a Patient carrying its PID-3 identifier", async () => {
  await adtAck();
  const patient = await patientWithIdentifier(adt.mrn, stack.timeoutMs);
  expect(patient.identifier?.map((identifier) => identifier.value)).toContain(adt.mrn);
}, TEST_TIMEOUT_MS);

test("the MLLP source acknowledges an ORU^R01 with AA", async () => {
  expect(msaOf(await oruAck())).toEqual({ code: "AA", control: oru.control });
}, TEST_TIMEOUT_MS);

test("the ORU^R01 reaches Aidbox as its patient's glucose Observation", async () => {
  await oruAck();
  const share = stack.timeoutMs / 2;
  const observation = await observationOf(await patientWithIdentifier(oru.mrn, share), share);
  expect(observation).toMatchObject({ status: "final", valueQuantity: { value: 95, unit: "mg/dL" } });
  expect(observation.code.coding?.map((coding) => coding.code)).toContain(GLUCOSE);
}, TEST_TIMEOUT_MS);

test("the dashboard API lists the hl7-to-aidbox pipeline", async () => {
  const pipelines = await dashboardGet<PipelineSummary[]>("/api/pipelines");
  expect(pipelines.map((pipeline) => pipeline.name)).toContain(PIPELINE);
}, TEST_TIMEOUT_MS);

test("the dashboard API shows the ADT^A01 and ORU^R01 units at sent", async () => {
  await Promise.all([adtAck(), oruAck()]);
  const units = await Promise.all([adt.mrn, oru.mrn].map((mrn) => settledUnitOf(mrn, stack.timeoutMs)));
  for (const unit of units) expect(unit).toMatchObject({ status: "sent" });
}, TEST_TIMEOUT_MS);
