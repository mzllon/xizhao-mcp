/**
 * Policy API routes.
 *
 * Endpoints:
 *   GET   /api/policy/:connName — Get current policy config
 *   PATCH /api/policy/:connName — Update policy config
 */
import type BetterSqlite3 from "better-sqlite3";
import { Hono } from "hono";
import { getConnection, updateConnection } from "../../core/connection.js";

export function createPolicyApi(deps: {
  getDb: () => BetterSqlite3.Database;
  getMasterKey: () => Buffer;
}): Hono {
  const router = new Hono();

  // Get policy for a connection
  router.get("/:connName", (c) => {
    const db = deps.getDb();
    const key = deps.getMasterKey();
    try {
      const conn = getConnection(db, c.req.param("connName"), key);
      const policy = JSON.parse(conn.policy) as Record<string, unknown>;
      return c.json({ connectionName: conn.name, policy });
    } catch {
      return c.json({ error: "Connection not found" }, 404);
    }
  });

  // Update policy for a connection
  router.patch("/:connName", async (c) => {
    const db = deps.getDb();
    const key = deps.getMasterKey();
    const connName = c.req.param("connName");
    const body = (await c.req.json()) as Record<string, unknown>;

    try {
      // Verify connection exists
      const conn = getConnection(db, connName, key);
      const currentPolicy = JSON.parse(conn.policy) as Record<string, unknown>;
      const updatedPolicy = { ...currentPolicy, ...body };
      const policyJson = JSON.stringify(updatedPolicy);

      updateConnection(db, connName, { policy: policyJson }, key);
      return c.json({ connectionName: connName, policy: updatedPolicy });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return c.json({ error: message }, 400);
    }
  });

  return router;
}
