/**
 * Approval API routes.
 *
 * Endpoints:
 *   GET  /api/approvals          — List all tasks (pending first)
 *   GET  /api/approvals/:taskId  — Get task details
 *   POST /api/approvals/:taskId/approve — Approve (optionally with modifiedSql)
 *   POST /api/approvals/:taskId/deny    — Deny (optionally with note)
 */
import type BetterSqlite3 from "better-sqlite3";
import { Hono } from "hono";
import {
  approveTask,
  denyTask,
  getTask,
  listPendingTasks,
  listRecentTasks,
} from "../../core/approval.js";

export function createApprovalsApi(getDb: () => BetterSqlite3.Database): Hono {
  const router = new Hono();

  // List all tasks: pending first, then recent history
  router.get("/", (c) => {
    const db = getDb();
    const pending = listPendingTasks(db);
    const recent = listRecentTasks(db, 100);
    // Filter out pending tasks from recent (avoid duplicates)
    const pendingIds = new Set(pending.map((t) => t.id));
    const history = recent.filter((t) => !pendingIds.has(t.id));
    return c.json({ pending, history });
  });

  // Get single task
  router.get("/:taskId", (c) => {
    const db = getDb();
    const task = getTask(db, c.req.param("taskId"));
    if (!task) return c.json({ error: "Task not found" }, 404);
    return c.json(task);
  });

  // Approve
  router.post("/:taskId/approve", async (c) => {
    const db = getDb();
    const taskId = c.req.param("taskId");
    const body = (await c.req.json().catch(() => ({}))) as {
      modifiedSql?: string;
      note?: string;
    };
    try {
      approveTask(db, taskId, {
        modifiedSql: body.modifiedSql,
        note: body.note,
        deciderKind: "dashboard",
      });
      return c.json({ ok: true, taskId });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return c.json({ error: message }, 400);
    }
  });

  // Deny
  router.post("/:taskId/deny", async (c) => {
    const db = getDb();
    const taskId = c.req.param("taskId");
    const body = (await c.req.json().catch(() => ({}))) as {
      note?: string;
    };
    try {
      denyTask(db, taskId, {
        note: body.note,
        deciderKind: "dashboard",
      });
      return c.json({ ok: true, taskId });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return c.json({ error: message }, 400);
    }
  });

  return router;
}
