import type { StageContext, StageFanout, StageHandler, StageMessage } from "@health-samurai/interbox";

// The `root` stage — reference-integrity by construction. Every built resource is
// a root; the handler emits that root's transitive reference closure into the
// send queue under one group_id, so the sender posts each closure as a single,
// reference-closed transaction (no dangling refs under Aidbox validation).
// Overlapping closures dedup via resource_hash on send.

/** Fan-out (runs once when `build` drains): one `root` message per built
 *  resource of the snapshot. */
export function closureFanout(): StageFanout {
  return async (ctx: StageContext, snapshot: string): Promise<void> => {
    const rows = await ctx.sql<{ resource_type: string; id: string }>`
      SELECT resource_type, id FROM built_resources WHERE snapshot_id = ${snapshot}`;
    for (const r of rows) {
      await ctx.emit("root", { payload: { resource_type: r.resource_type, id: r.id } });
    }
  };
}

/** Handler: walk one root's transitive closure over `built_resources.refs` and
 *  enqueue every resource in it under the root's group_id. */
export function closureHandler(): StageHandler {
  return async (ctx: StageContext, msg: StageMessage): Promise<void> => {
    const snapshot = ctx.snapshot;
    const { resource_type, id } = (msg.payload ?? {}) as { resource_type?: string; id?: string };
    if (!snapshot || !resource_type || !id) throw new Error("root: message missing snapshot/root");

    const closure = (await ctx.exec(
      `WITH RECURSIVE closure(resource_type, id, resource, refs) AS (
         SELECT resource_type, id, resource, refs
           FROM built_resources
          WHERE snapshot_id = $1 AND resource_type = $2 AND id = $3
         UNION
         SELECT br.resource_type, br.id, br.resource, br.refs
           FROM closure c
           JOIN built_resources br
             ON br.snapshot_id = $1
            AND (br.resource_type || '/' || br.id) = ANY (c.refs)
       )
       SELECT DISTINCT resource_type, id, resource FROM closure`,
      [snapshot, resource_type, id],
    )) as { resource: { resourceType: string; id: string } & Record<string, unknown> }[];

    const groupId = `${snapshot}:${resource_type}/${id}`;
    for (const row of closure) {
      await ctx.enqueue(row.resource, { groupId });
    }
  };
}
