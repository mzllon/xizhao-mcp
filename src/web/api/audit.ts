/**
 * Audit API routes.
 *
 * Endpoints:
 *   GET /api/audit     — Paginated audit log (with filters)
 *   GET /api/audit/:id — Single record detail
 *   GET /api/audit/chain — Verify hash chain integrity
 */
import type BetterSqlite3 from "better-sqlite3";
import { Hono } from "hono";
import { verifyAuditChain } from "../../core/audit.js";

export function createAuditApi(getDb: () => BetterSqlite3.Database): Hono {
  const router = new Hono();

  // List audit records with filters
  router.get("/", (c) => {
    const db = getDb();
    const limit = Number(c.req.query("limit")) || 50;
    const offset = Number(c.req.query("offset")) || 0;
    const since = c.req.query("since"); // ISO date string
    const connection = c.req.query("connection");
    const decision = c.req.query("decision");
    const sql = c.req.query("sql");

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (since) {
      conditions.push("created_at >= ?");
      params.push(since);
    }
    if (connection) {
      conditions.push("connection_name = ?");
      params.push(connection);
    }
    if (decision) {
      conditions.push("decision = ?");
      params.push(decision);
    }
    if (sql) {
      conditions.push("sql LIKE ?");
      params.push(`%${sql}%`);
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const rows = db
      .prepare(
        `SELECT id, created_at, tool_name, connection_name, sql, decision,
              trigger_rule, reason, exec_status, mysql_error_code,
              row_count, truncated, policy_duration_ms, exec_duration_ms
       FROM audit_log ${where}
       ORDER BY rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Record<string, unknown>[];

    const countRow = db
      .prepare(`SELECT COUNT(*) as total FROM audit_log ${where}`)
      .get(...params) as Record<string, unknown>;

    return c.json({
      records: rows,
      total: countRow.total as number,
      limit,
      offset,
    });
  });

  // Get single audit record
  router.get("/:id", (c) => {
    const db = getDb();
    const row = db
      .prepare(`SELECT * FROM audit_log WHERE id = ?`)
      .get(c.req.param("id")) as Record<string, unknown> | undefined;

    if (!row) return c.json({ error: "Record not found" }, 404);
    return c.json(row);
  });

  // Verify hash chain
  router.get("/chain/verify", (c) => {
    const db = getDb();
    const result = verifyAuditChain(db);
    return c.json(result);
  });

  return router;
}
