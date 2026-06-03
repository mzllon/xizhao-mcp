/**
 * Approval task lifecycle management.
 *
 * Implements the state machine for self-approval workflow:
 *   pending → approved → consumed
 *   pending → denied
 *   pending → expired
 *
 * Key invariants:
 *   - Only pending tasks can transition to approved/denied/expired
 *   - Only approved tasks can be consumed
 *   - consumed/denied/expired are terminal states
 *   - consume is atomic (same transaction as lookup) to prevent replay
 *
 * See ADR-0008 (policy rules and approval workflow).
 */
import type BetterSqlite3 from "better-sqlite3";

import { generateUlid } from "../shared/ids.js";
import { nowIso } from "../shared/time.js";

// ─── Types ─────────────────────────────────────────────────────

export type ApprovalTaskStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "consumed";

export interface ApprovalTask {
  id: string;
  createdAt: string;
  expiresAt: string;
  connectionName: string;
  sql: string;
  sqlHash: string;
  statementType: string;
  triggerRule: string;
  status: ApprovalTaskStatus;
  decidedAt?: string | undefined;
  deciderKind?: string | undefined;
  modifiedSql?: string | undefined;
  decisionNote?: string | undefined;
  auditId?: string | undefined;
}

export interface CreateApprovalTaskInput {
  sql: string;
  sqlHash: string;
  connectionName: string;
  statementType: string;
  triggerRule: string;
  /** TTL in milliseconds (default: 24 hours) */
  ttlMs?: number | undefined;
}

// ─── Constants ─────────────────────────────────────────────────

/** Default task TTL: 24 hours */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

// ─── Internal helpers ──────────────────────────────────────────

function rowToTask(row: Record<string, unknown>): ApprovalTask {
  return {
    id: row.id as string,
    createdAt: row.created_at as string,
    expiresAt: row.expires_at as string,
    connectionName: row.connection_name as string,
    sql: row.sql as string,
    sqlHash: row.sql_hash as string,
    statementType: row.statement_type as string,
    triggerRule: row.trigger_rule as string,
    status: row.status as ApprovalTaskStatus,
    decidedAt: (row.decided_at as string | null) ?? undefined,
    deciderKind: (row.decider_kind as string | null) ?? undefined,
    modifiedSql: (row.modified_sql as string | null) ?? undefined,
    decisionNote: (row.decision_note as string | null) ?? undefined,
    auditId: (row.audit_id as string | null) ?? undefined,
  };
}

// ─── CRUD ──────────────────────────────────────────────────────

/** Create a new approval task in pending state. */
export function createApprovalTask(
  db: BetterSqlite3.Database,
  input: CreateApprovalTaskInput,
): ApprovalTask {
  const id = generateUlid();
  const now = nowIso();
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  db.prepare(
    `INSERT INTO approval_tasks
     (id, created_at, expires_at, connection_name, sql, sql_hash,
      statement_type, trigger_rule, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
  ).run(
    id,
    now,
    expiresAt,
    input.connectionName,
    input.sql,
    input.sqlHash,
    input.statementType,
    input.triggerRule,
  );

  return {
    id,
    createdAt: now,
    expiresAt,
    connectionName: input.connectionName,
    sql: input.sql,
    sqlHash: input.sqlHash,
    statementType: input.statementType,
    triggerRule: input.triggerRule,
    status: "pending",
  };
}

/** Get a single approval task by ID. Returns null if not found. */
export function getTask(
  db: BetterSqlite3.Database,
  id: string,
): ApprovalTask | null {
  const row = db
    .prepare("SELECT * FROM approval_tasks WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToTask(row) : null;
}

/** List all pending approval tasks (for Dashboard). */
export function listPendingTasks(db: BetterSqlite3.Database): ApprovalTask[] {
  const rows = db
    .prepare(
      "SELECT * FROM approval_tasks WHERE status = 'pending' ORDER BY created_at DESC",
    )
    .all() as Record<string, unknown>[];
  return rows.map(rowToTask);
}

/** List recent tasks within the last 30 days (for Dashboard). */
export function listRecentTasks(
  db: BetterSqlite3.Database,
  limit: number,
): ApprovalTask[] {
  const rows = db
    .prepare(
      `SELECT * FROM approval_tasks
       WHERE created_at > datetime('now', '-30 days')
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

// ─── State transitions ─────────────────────────────────────────

/**
 * Approve a pending task.
 * Optionally provide modified SQL and a note.
 * Throws if task not found or not in pending status.
 */
export function approveTask(
  db: BetterSqlite3.Database,
  id: string,
  opts?:
    | {
        modifiedSql?: string | undefined;
        note?: string | undefined;
        deciderKind?: string | undefined;
      }
    | undefined,
): void {
  const now = nowIso();
  const result = db
    .prepare(
      `UPDATE approval_tasks
       SET status = 'approved', decided_at = ?, decider_kind = ?,
           modified_sql = ?, decision_note = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(
      now,
      opts?.deciderKind ?? "human",
      opts?.modifiedSql ?? null,
      opts?.note ?? null,
      id,
    );

  if (result.changes === 0) {
    const task = getTask(db, id);
    if (!task) throw new Error(`Task "${id}" not found`);
    throw new Error(
      `Task "${id}" is not pending (current status: ${task.status})`,
    );
  }
}

/**
 * Deny a pending task.
 * Throws if task not found or not in pending status.
 */
export function denyTask(
  db: BetterSqlite3.Database,
  id: string,
  opts?: { note?: string | undefined; deciderKind?: string | undefined },
): void {
  const now = nowIso();
  const result = db
    .prepare(
      `UPDATE approval_tasks
       SET status = 'denied', decided_at = ?, decider_kind = ?, decision_note = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(now, opts?.deciderKind ?? "human", opts?.note ?? null, id);

  if (result.changes === 0) {
    const task = getTask(db, id);
    if (!task) throw new Error(`Task "${id}" not found`);
    throw new Error(
      `Task "${id}" is not pending (current status: ${task.status})`,
    );
  }
}

/**
 * Consume an approved task (mark as consumed after execution).
 * Prevents replay — can only transition approved → consumed.
 * Uses conditional UPDATE for atomicity.
 */
export function consumeTask(db: BetterSqlite3.Database, id: string): void {
  const result = db
    .prepare(
      "UPDATE approval_tasks SET status = 'consumed' WHERE id = ? AND status = 'approved'",
    )
    .run(id);

  if (result.changes === 0) {
    const task = getTask(db, id);
    if (!task) throw new Error(`Task "${id}" not found`);
    throw new Error(
      `Task "${id}" cannot be consumed (current status: ${task.status})`,
    );
  }
}

/**
 * Find an approved (unexpired) task matching the given SQL hash + connection.
 * If found, atomically consume it and return the modified SQL (if any).
 *
 * Used by the approved-task-override policy rule to auto-allow
 * previously approved SQL without creating a new approval task.
 *
 * Returns null if no matching approved task exists.
 */
export function findAndConsumeApproved(
  db: BetterSqlite3.Database,
  sqlHash: string,
  connectionName: string,
): { modifiedSql?: string | undefined } | null {
  const consume = db.transaction(() => {
    const row = db
      .prepare(
        `SELECT id, modified_sql FROM approval_tasks
         WHERE sql_hash = ? AND connection_name = ? AND status = 'approved'
         AND decided_at > datetime('now', '-1 hour')`,
      )
      .get(sqlHash, connectionName) as Record<string, unknown> | undefined;

    if (!row) return null;

    db.prepare(
      "UPDATE approval_tasks SET status = 'consumed' WHERE id = ? AND status = 'approved'",
    ).run(row.id);

    return {
      modifiedSql: (row.modified_sql as string | null) ?? undefined,
    };
  });

  return consume();
}

/**
 * Expire all overdue pending tasks.
 * Idempotent — safe to run concurrently from multiple processes.
 *
 * @returns Number of tasks expired
 */
export function expireOverdueTasks(
  db: BetterSqlite3.Database,
  now: Date,
): number {
  const nowStr = now.toISOString();
  const result = db
    .prepare(
      `UPDATE approval_tasks
       SET status = 'expired'
       WHERE status = 'pending' AND expires_at < ?`,
    )
    .run(nowStr);

  return result.changes;
}
