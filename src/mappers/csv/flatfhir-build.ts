import { scratchTableName } from "@health-samurai/interbox";
import type { StageContext, StageFanout, StageHandler, StageMessage } from "@health-samurai/interbox";
import { compileRaw } from "../../../vendor/flatfhir/src/compile.ts";
import { emptyProfile } from "../../../vendor/flatfhir/src/profile.ts";
import { expandBuildSQL } from "../../../vendor/flatfhir/src/sql.ts";

// The `build` stage — flatfhir as a workspace mapper (mapping-as-code). It runs
// AFTER the `ingest_file` stage has loaded every scratch table (barrier). The
// barrier fans out ONE `build` message PER resource type (view); each message
// builds a single view's resources into `built_resources`. Pure workspace code:
// the engine knows nothing of flatfhir, views, or built_resources.

/** A flatfhir view authored against a snapshot's scratch table. `table` is the
 *  *logical* type (matches the scratch table's base name); the handler rewrites
 *  it to the snapshot-schema-local scratch table via {@link scratchTableName}.
 *  Everything else is passed through to flatfhir. */
export interface FlatfhirView {
  resource: string;
  /** Logical type, e.g. "patient" — the scratch table's base name. */
  table: string;
  key: string;
  columns: Record<string, unknown>;
  select?: unknown;
  profile?: string;
}

const BUILT_RESOURCES_DDL = `
  CREATE TABLE IF NOT EXISTS built_resources (
    snapshot_id   text  NOT NULL,
    resource_type text  NOT NULL,
    id            text  NOT NULL,
    resource      jsonb NOT NULL,
    refs          text[] NOT NULL DEFAULT '{}',
    PRIMARY KEY (snapshot_id, resource_type, id)
  )`;

/** Per-`build`-message work: which view (resource type + scratch table) to build. */
interface BuildPayload {
  resource: string;
  table: string;
}

/**
 * Fan-out (runs once, single-threaded, when `ingest_file` drains for a snapshot):
 * create `built_resources` up front — so the parallel per-view handlers only ever
 * INSERT, never race on the DDL — then emit one `build` message per view.
 */
export function buildFanout(views: FlatfhirView[]): StageFanout {
  return async (ctx: StageContext, _snapshot: string): Promise<void> => {
    await ctx.exec(BUILT_RESOURCES_DDL);
    for (const view of views) {
      await ctx.emit("build", { payload: { resource: view.resource, table: view.table } satisfies BuildPayload });
    }
  };
}

/**
 * Build handler: compile the ONE view named in the message payload to native SQL,
 * run it over the snapshot's scratch table, and upsert the resulting resources
 * (+ their literal references, lifted from the jsonb for the closure walk) into
 * `built_resources`. Set-based. Idempotent per view (clears only this resource
 * type's rows for the snapshot, then upserts on conflict) — so parallel views and
 * re-drives don't clobber each other.
 */
export function flatfhirBuild(views: FlatfhirView[]): StageHandler {
  return async (ctx: StageContext, msg: StageMessage): Promise<void> => {
    const snapshot = ctx.snapshot;
    if (!snapshot) throw new Error("build: message has no snapshot_id");
    const { resource, table } = (msg.payload ?? {}) as Partial<BuildPayload>;
    const view = views.find((v) => v.resource === resource && v.table === table);
    if (!view) throw new Error(`build: no view for resource=${resource} table=${table}`);

    const compiled = compileRaw({ ...view, table: scratchTableName(view.table) }, emptyProfile());
    const selectSql = expandBuildSQL(compiled); // → SELECT rid, resource

    // Clear only THIS view's rows first (parallel views own disjoint resource
    // types), then upsert. `#>> '{}'` unwraps each jsonb reference string to text;
    // the lifted refs are the adjacency the root stage walks.
    await ctx.exec(`DELETE FROM built_resources WHERE snapshot_id = $1 AND resource_type = $2`, [
      snapshot,
      view.resource,
    ]);
    const insert = `
      INSERT INTO built_resources (snapshot_id, resource_type, id, resource, refs)
      SELECT $1,
             v.resource->>'resourceType',
             v.rid,
             v.resource,
             COALESCE(
               (SELECT array_agg(r #>> '{}')
                  FROM jsonb_path_query(v.resource, '$.**.reference') AS r),
               '{}')
      FROM (${selectSql}) v
      WHERE v.resource IS NOT NULL
      ON CONFLICT (snapshot_id, resource_type, id)
        DO UPDATE SET resource = EXCLUDED.resource, refs = EXCLUDED.refs`;
    await ctx.exec(insert, [snapshot]);
  };
}
