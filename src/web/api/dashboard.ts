/**
 * Dashboard overview API.
 *
 * Endpoint:
 *   GET /api/dashboard/overview — Aggregated stats
 */
import type BetterSqlite3 from "better-sqlite3";
import fs from "node:fs";
import { Hono } from "hono";
import { getPaths } from "../../core/app-paths.js";
import { listPendingTasks } from "../../core/approval.js";
import { listConnections } from "../../core/connection.js";

export function createDashboardApi(getDb: () => BetterSqlite3.Database): Hono {
  const router = new Hono();

  router.get("/overview", (c) => {
    const db = getDb();
    const paths = getPaths();

    // Connections count
    const connections = listConnections(db);

    // Pending approvals
    const pending = listPendingTasks(db);

    // Audit stats (last 24h)
    const stats = db
      .prepare(
        `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN decision = 'deny' THEN 1 ELSE 0 END) as denied,
         SUM(CASE WHEN decision = 'need_approval' THEN 1 ELSE 0 END) as needApproval
       FROM audit_log
       WHERE created_at > datetime('now', '-1 day')`,
      )
      .get() as Record<string, unknown>;

    // Master key info
    let keyInfo: { exists: boolean; fingerprint?: string } = { exists: false };
    try {
      const keyPath = paths.masterKey;
      if (fs.existsSync(keyPath)) {
        const stat = fs.statSync(keyPath);
        keyInfo = {
          exists: true,
          fingerprint: `${stat.size}bytes:${stat.mtime.toISOString().slice(0, 10)}`,
        };
      }
    } catch {
      // Ignore
    }

    return c.json({
      connectionsCount: connections.length,
      pendingApprovals: pending.length,
      auditStats: {
        last24h: {
          total: (stats.total as number) ?? 0,
          denied: (stats.denied as number) ?? 0,
          needApproval: (stats.needApproval as number) ?? 0,
        },
      },
      masterKey: keyInfo,
    });
  });

  return router;
}
