import { expect, test } from "bun:test";
import { env } from "@health-samurai/interbox";
import { aidbox } from "@health-samurai/interbox/aidbox";
import {
  beforeStore,
  type ChainRegistry,
  type NamedStep,
  type PipelineDef,
  type Side,
  type StepContext,
  type StepDef,
} from "@health-samurai/interbox/chain";
import * as entry from "../src/index.ts";
import * as mappers from "../src/mappers/v2-to-fhir/index.ts";

const PIPELINE = "hl7-to-aidbox";
const PARSER = "hl7v2.parse";
const FHIR_ITEMS = "aidbox.fhir-items";
const SKIP_UNCHANGED = "aidbox.skip-unchanged";

const RAW_ADT_A01 = [
  "MSH|^~\\&|LABCORP|HOSPA|RECV|RECVFAC|20260729100000||ADT^A01|MSG00001|P|2.5.1",
  "PID|1||PATID1234^^^HOSPA^MR||DOE^JOHN^A||19700101|M",
].join("\r");

const refused = (): never => {
  throw new Error("the search-text step reads nothing from its context");
};

const readsNothing: StepContext = {
  signal: new AbortController().signal,
  state: refused,
  sender: { queued: refused },
  units: { count: refused, find: refused },
  translate: refused,
  translateFor: refused,
  conceptMapFor: refused,
};

const exportsOf = (module: object): Record<string, unknown> => ({ ...module });

function registry(): typeof ChainRegistry {
  const exported = exportsOf(entry).ChainRegistry;
  if (exported === undefined) throw new Error("src/index.ts exports no ChainRegistry");
  return exported as typeof ChainRegistry;
}

function hl7ToAidbox(): PipelineDef {
  const def = registry().defs().find((d) => d.name === PIPELINE);
  if (def === undefined) throw new Error(`src/index.ts declares no pipeline named ${PIPELINE}`);
  return def;
}

function mappingStep(): NamedStep<unknown, unknown> {
  const exported = exportsOf(mappers).v2ToFhir;
  if (exported === undefined) throw new Error("src/mappers/v2-to-fhir/index.ts exports no v2ToFhir step");
  return exported as NamedStep<unknown, unknown>;
}

const namesOn = (side: Side, steps: readonly StepDef[]): string[] =>
  steps.filter((step) => step.side === side).map((step) => step.name);

test("src/index.ts exports the ChainRegistry and neither 1.x registry", () => {
  const names = Object.keys(exportsOf(entry));
  expect(names).toContain("ChainRegistry");
  expect(names).not.toContain("MapperRegistry");
  expect(names).not.toContain("PipelineRegistry");
});

test("the registry holds the hl7-to-aidbox pipeline", () => {
  expect(registry().defs().map((def) => def.name)).toContain(PIPELINE);
});

test("hl7-to-aidbox listens on an MLLP source bound by MLLP_HOST and MLLP_PORT", () => {
  expect(hl7ToAidbox().source).toMatchObject({
    kind: "mllp",
    config: { host: env("MLLP_HOST"), port: env("MLLP_PORT") },
  });
});

test("the store keeps the raw message as text, so it comes before the parser", () => {
  const def = hl7ToAidbox();
  expect(def.store.codec).toBe("text");
  expect(def.steps.find((step) => step.name === PARSER)?.side).toBe("after");
});

test("the store indexes message_type, event_type and patient_id by btree, and the search text by trigram", () => {
  const { index, search } = hl7ToAidbox().store;
  expect(index).toEqual({ message_type: "btree", event_type: "btree", patient_id: "btree" });
  expect(search).toBe("trgm");
});

test("the one step before the store makes the raw message the unit's search text", async () => {
  const sides = hl7ToAidbox().steps.map((step) => step.side);
  expect(sides.filter((side) => side === "before")).toHaveLength(1);

  const searchTextStep = registry().handlers(PIPELINE).steps[sides.indexOf("before")];
  if (searchTextStep === undefined) throw new Error("the step before the store has no handler");
  const run = beforeStore(RAW_ADT_A01);
  const rows = await Array.fromAsync(run.rows(await searchTextStep(run.batch, readsNothing)));

  expect(rows).toEqual([{ kind: "unit", value: RAW_ADT_A01, attrs: {}, searchText: RAW_ADT_A01 }]);
});

test("after the store it parses, maps with v2ToFhir, keys the resources and drops unchanged ones, in that order", () => {
  expect(namesOn("after", hl7ToAidbox().steps)).toEqual([PARSER, mappingStep().name, FHIR_ITEMS, SKIP_UNCHANGED]);
});

test("the mapping step the pipeline runs is the v2ToFhir step the mappers module exports", () => {
  const step = mappingStep();
  const index = hl7ToAidbox().steps.findIndex((def) => def.name === step.name);
  expect(registry().handlers(PIPELINE).steps[index]).toBe(step.fn);
});

test("it delivers through aidbox(): the sender carries aidbox()'s retry tuning", () => {
  const { kind, maxRetries, retryDelayMs, runTimeoutMs } = aidbox({
    url: env("AIDBOX_URL"),
    auth: { kind: "basic", user: env("AIDBOX_CLIENT_ID", "root"), password: env("AIDBOX_CLIENT_SECRET") },
  });
  expect(hl7ToAidbox().sender).toMatchObject({ kind, maxRetries, retryDelayMs, runTimeoutMs });
});
