import { scratchTableName } from "@health-samurai/interbox";
import type { StageContext, StageHandler, StageMessage } from "@health-samurai/interbox";
import { compileRaw } from "../../vendor/flatfhir/src/compile.ts";
import { emptyProfile } from "../../vendor/flatfhir/src/profile.ts";
import { expandBuildSQL } from "../../vendor/flatfhir/src/sql.ts";

// The `build` stage's handler — flatfhir as a workspace mapper (mapping-as-code).
// It runs each profile-bound view's compiled SQL over the snapshot's scratch
// tables and lands the resources in `built_resources`. Pure workspace code: the
// engine knows nothing of flatfhir, views, or built_resources.

/** A flatfhir view authored against a snapshot's scratch table. `table` is the
 *  *logical* type (matches the manifest `type` = the scratch table's base name);
 *  the handler rewrites it to the snapshot-specific scratch table via
 *  {@link scratchTableName}. Everything else is passed through to flatfhir. */
export interface FlatfhirView {
  resource: string;
  /** Logical type, e.g. "patient" — resolved to `patient_<snapshot>`. */
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

/**
 * Build handler: for each view, compile it to native SQL, run it over the
 * snapshot's scratch table, and upsert the resulting resources (+ their literal
 * references, lifted from the jsonb for the closure walk) into
 * `built_resources`. Set-based — one `build` message builds the whole snapshot.
 * Idempotent (clears the snapshot's rows first, upserts on conflict).
 */
export function flatfhirBuild(views: FlatfhirView[]): StageHandler {
  return async (ctx: StageContext, _msg: StageMessage): Promise<void> => {
    const snapshot = ctx.snapshot;
    if (!snapshot) throw new Error("build: message has no snapshot_id");

    await ctx.exec(BUILT_RESOURCES_DDL);
    await ctx.exec(`DELETE FROM built_resources WHERE snapshot_id = $1`, [snapshot]);

    for (const view of views) {
      const compiled = compileRaw(
        { ...view, table: scratchTableName(view.table, snapshot) },
        emptyProfile(),
      );
      const selectSql = expandBuildSQL(compiled); // → SELECT rid, resource
      // Lift resource_type + every literal reference out of the jsonb; refs are
      // the adjacency the root stage walks. `#>> '{}'` unwraps the jsonb string.
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
    }
  };
}
