/**
 * Connections API routes.
 *
 * Endpoints:
 *   GET   /api/connections          — List all connections (no passwords)
 *   GET   /api/connections/:name    — Get connection details (no password)
 *   POST  /api/connections          — Create connection
 *   PATCH /api/connections/:name    — Update connection
 *   DELETE /api/connections/:name   — Delete connection
 *   POST  /api/connections/:name/test — Test MySQL connectivity
 */
import type BetterSqlite3 from "better-sqlite3";
import { Hono } from "hono";
import {
  createConnection,
  deleteConnection,
  getConnection,
  listConnections,
  updateConnection,
} from "../../core/connection.js";

export function createConnectionsApi(deps: {
  getDb: () => BetterSqlite3.Database;
  getMasterKey: () => Buffer;
}): Hono {
  const router = new Hono();

  // List all connections
  router.get("/", (c) => {
    const db = deps.getDb();
    return c.json(listConnections(db));
  });

  // Get single connection (without password)
  router.get("/:name", (c) => {
    const db = deps.getDb();
    const key = deps.getMasterKey();
    try {
      const conn = getConnection(db, c.req.param("name"), key);
      const { password: _, ...info } = conn;
      return c.json(info);
    } catch {
      return c.json({ error: "Connection not found" }, 404);
    }
  });

  // Create connection
  router.post("/", async (c) => {
    const db = deps.getDb();
    const key = deps.getMasterKey();
    const body = (await c.req.json()) as {
      name: string;
      host: string;
      port: number;
      username: string;
      password: string;
      defaultSchema?: string;
      policy: string;
      description?: string;
    };
    try {
      const info = createConnection(db, body, key);
      return c.json(info, 201);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return c.json({ error: message }, 400);
    }
  });

  // Update connection
  router.patch("/:name", async (c) => {
    const db = deps.getDb();
    const key = deps.getMasterKey();
    const name = c.req.param("name");
    const body = (await c.req.json()) as {
      host?: string;
      port?: number;
      username?: string;
      password?: string;
      defaultSchema?: string;
      policy?: string;
      description?: string;
    };
    try {
      const info = updateConnection(db, name, body, key);
      return c.json(info);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return c.json({ error: message }, 404);
    }
  });

  // Delete connection
  router.delete("/:name", (c) => {
    const db = deps.getDb();
    try {
      deleteConnection(db, c.req.param("name"));
      return c.json({ ok: true });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return c.json({ error: message }, 404);
    }
  });

  // Test MySQL connectivity
  router.post("/:name/test", async (c) => {
    const db = deps.getDb();
    const key = deps.getMasterKey();
    try {
      const conn = getConnection(db, c.req.param("name"), key);
      const mysql = await import("mysql2/promise");
      const testPool = mysql.createPool({
        host: conn.host,
        port: conn.port,
        user: conn.username,
        password: conn.password,
        connectionLimit: 1,
        connectTimeout: 5000,
      });
      const start = Date.now();
      const conn2 = await testPool.getConnection();
      const latency = Date.now() - start;
      conn2.release();
      await testPool.end();
      return c.json({ ok: true, latencyMs: latency });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return c.json({ ok: false, error: message }, 200);
    }
  });

  return router;
}
