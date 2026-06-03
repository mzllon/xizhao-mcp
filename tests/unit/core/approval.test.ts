/**
 * Unit tests for the approval task lifecycle (src/core/approval.ts).
 *
 * Tests:
 *   - Create task → fields correct
 *   - State transitions: approve, deny, consume, expire
 *   - Invalid transitions throw errors
 *   - findAndConsumeApproved atomicity
 *   - listPendingTasks / listRecentTasks
 */
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  approveTask,
  consumeTask,
  createApprovalTask,
  denyTask,
  expireOverdueTasks,
  findAndConsumeApproved,
  getTask,
  listPendingTasks,
  listRecentTasks,
} from "../../../src/core/approval.js";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS approval_tasks (
      id              TEXT PRIMARY KEY,
      created_at      TEXT NOT NULL,
      expires_at      TEXT NOT NULL,
      connection_name TEXT NOT NULL,
      sql             TEXT NOT NULL,
      sql_hash        TEXT NOT NULL,
      statement_type  TEXT NOT NULL,
      trigger_rule    TEXT NOT NULL,
      status          TEXT NOT NULL,
      decided_at      TEXT,
      decider_kind    TEXT,
      modified_sql    TEXT,
      decision_note   TEXT,
      audit_id        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_approval_tasks_sql_hash
      ON approval_tasks(sql_hash, connection_name, status);
    CREATE INDEX IF NOT EXISTS idx_approval_tasks_status
      ON approval_tasks(status, expires_at);
  `);
  return db;
}

function makeHash(sql: string): string {
  return crypto.createHash("sha256").update(sql).digest("hex");
}

describe("createApprovalTask", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  it("creates a task with correct fields", () => {
    const sql = "CREATE TABLE foo (id INT)";
    const task = createApprovalTask(db, {
      sql,
      sqlHash: makeHash(sql),
      connectionName: "test-conn",
      statementType: "create_table",
      triggerRule: "need-approval-statement-types",
    });

    expect(task.id).toBeTruthy();
    expect(task.status).toBe("pending");
    expect(task.sql).toBe(sql);
    expect(task.sqlHash).toBe(makeHash(sql));
    expect(task.connectionName).toBe("test-conn");
    expect(task.statementType).toBe("create_table");
    expect(task.triggerRule).toBe("need-approval-statement-types");
    expect(task.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(task.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("uses default 24h TTL when ttlMs not provided", () => {
    const before = Date.now();
    const task = createApprovalTask(db, {
      sql: "DROP TABLE x",
      sqlHash: makeHash("DROP TABLE x"),
      connectionName: "c",
      statementType: "drop_table",
      triggerRule: "test",
    });
    const after = Date.now();

    const expiresAt = new Date(task.expiresAt).getTime();
    // Should be roughly 24h from now (within test execution window)
    expect(expiresAt).toBeGreaterThanOrEqual(before + 24 * 3600_000 - 100);
    expect(expiresAt).toBeLessThanOrEqual(after + 24 * 3600_000 + 100);
  });

  it("uses custom TTL when provided", () => {
    const task = createApprovalTask(db, {
      sql: "DROP TABLE x",
      sqlHash: makeHash("DROP TABLE x"),
      connectionName: "c",
      statementType: "drop_table",
      triggerRule: "test",
      ttlMs: 3600_000, // 1 hour
    });

    const expiresAt = new Date(task.expiresAt).getTime();
    const now = Date.now();
    expect(expiresAt).toBeGreaterThanOrEqual(now + 3500_000);
    expect(expiresAt).toBeLessThanOrEqual(now + 3700_000);
  });

  it("persists the task to the database", () => {
    const sql = "ALTER TABLE t ADD COLUMN x INT";
    createApprovalTask(db, {
      sql,
      sqlHash: makeHash(sql),
      connectionName: "c",
      statementType: "alter_table",
      triggerRule: "test",
    });

    const row = db.prepare("SELECT * FROM approval_tasks").get() as Record<
      string,
      unknown
    >;
    expect(row).toBeDefined();
    expect(row.status).toBe("pending");
    expect(row.sql).toBe(sql);
  });
});

describe("getTask", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  it("returns task by id", () => {
    const task = createApprovalTask(db, {
      sql: "SELECT 1",
      sqlHash: makeHash("SELECT 1"),
      connectionName: "c",
      statementType: "select",
      triggerRule: "test",
    });

    const fetched = getTask(db, task.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(task.id);
    expect(fetched!.sql).toBe("SELECT 1");
  });

  it("returns null for non-existent id", () => {
    expect(getTask(db, "nonexistent")).toBeNull();
  });
});

describe("approveTask", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  it("transitions pending → approved", () => {
    const task = createApprovalTask(db, {
      sql: "CREATE TABLE t (id INT)",
      sqlHash: makeHash("CREATE TABLE t (id INT)"),
      connectionName: "c",
      statementType: "create_table",
      triggerRule: "test",
    });

    approveTask(db, task.id);

    const updated = getTask(db, task.id);
    expect(updated!.status).toBe("approved");
    expect(updated!.decidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(updated!.deciderKind).toBe("human");
  });

  it("accepts modified SQL and note", () => {
    const task = createApprovalTask(db, {
      sql: "DROP TABLE users",
      sqlHash: makeHash("DROP TABLE users"),
      connectionName: "c",
      statementType: "drop_table",
      triggerRule: "test",
    });

    approveTask(db, task.id, {
      modifiedSql: "DROP TABLE temp_users",
      note: "Changed target table",
      deciderKind: "dashboard",
    });

    const updated = getTask(db, task.id);
    expect(updated!.status).toBe("approved");
    expect(updated!.modifiedSql).toBe("DROP TABLE temp_users");
    expect(updated!.decisionNote).toBe("Changed target table");
    expect(updated!.deciderKind).toBe("dashboard");
  });

  it("throws for non-existent task", () => {
    expect(() => approveTask(db, "nonexistent")).toThrow(
      'Task "nonexistent" not found',
    );
  });

  it("throws when task is already approved", () => {
    const task = createApprovalTask(db, {
      sql: "SELECT 1",
      sqlHash: makeHash("SELECT 1"),
      connectionName: "c",
      statementType: "select",
      triggerRule: "test",
    });
    approveTask(db, task.id);

    expect(() => approveTask(db, task.id)).toThrow(/not pending/);
  });

  it("throws when task is denied", () => {
    const task = createApprovalTask(db, {
      sql: "SELECT 1",
      sqlHash: makeHash("SELECT 1"),
      connectionName: "c",
      statementType: "select",
      triggerRule: "test",
    });
    denyTask(db, task.id);

    expect(() => approveTask(db, task.id)).toThrow(/not pending/);
  });
});

describe("denyTask", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  it("transitions pending → denied", () => {
    const task = createApprovalTask(db, {
      sql: "SELECT 1",
      sqlHash: makeHash("SELECT 1"),
      connectionName: "c",
      statementType: "select",
      triggerRule: "test",
    });

    denyTask(db, task.id, { note: "Too dangerous" });

    const updated = getTask(db, task.id);
    expect(updated!.status).toBe("denied");
    expect(updated!.decisionNote).toBe("Too dangerous");
    expect(updated!.deciderKind).toBe("human");
  });

  it("throws for non-existent task", () => {
    expect(() => denyTask(db, "nonexistent")).toThrow(
      'Task "nonexistent" not found',
    );
  });

  it("throws when task is already approved", () => {
    const task = createApprovalTask(db, {
      sql: "SELECT 1",
      sqlHash: makeHash("SELECT 1"),
      connectionName: "c",
      statementType: "select",
      triggerRule: "test",
    });
    approveTask(db, task.id);

    expect(() => denyTask(db, task.id)).toThrow(/not pending/);
  });
});

describe("consumeTask", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  it("transitions approved → consumed", () => {
    const task = createApprovalTask(db, {
      sql: "SELECT 1",
      sqlHash: makeHash("SELECT 1"),
      connectionName: "c",
      statementType: "select",
      triggerRule: "test",
    });
    approveTask(db, task.id);

    consumeTask(db, task.id);

    const updated = getTask(db, task.id);
    expect(updated!.status).toBe("consumed");
  });

  it("throws for pending task", () => {
    const task = createApprovalTask(db, {
      sql: "SELECT 1",
      sqlHash: makeHash("SELECT 1"),
      connectionName: "c",
      statementType: "select",
      triggerRule: "test",
    });

    expect(() => consumeTask(db, task.id)).toThrow(/cannot be consumed/);
  });

  it("throws for denied task", () => {
    const task = createApprovalTask(db, {
      sql: "SELECT 1",
      sqlHash: makeHash("SELECT 1"),
      connectionName: "c",
      statementType: "select",
      triggerRule: "test",
    });
    denyTask(db, task.id);

    expect(() => consumeTask(db, task.id)).toThrow(/cannot be consumed/);
  });

  it("throws for already consumed task", () => {
    const task = createApprovalTask(db, {
      sql: "SELECT 1",
      sqlHash: makeHash("SELECT 1"),
      connectionName: "c",
      statementType: "select",
      triggerRule: "test",
    });
    approveTask(db, task.id);
    consumeTask(db, task.id);

    expect(() => consumeTask(db, task.id)).toThrow(/cannot be consumed/);
  });

  it("throws for non-existent task", () => {
    expect(() => consumeTask(db, "nonexistent")).toThrow(
      'Task "nonexistent" not found',
    );
  });
});

describe("expireOverdueTasks", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  it("expires pending tasks past their expires_at", () => {
    const task = createApprovalTask(db, {
      sql: "SELECT 1",
      sqlHash: makeHash("SELECT 1"),
      connectionName: "c",
      statementType: "select",
      triggerRule: "test",
      ttlMs: 1000, // 1 second — will expire immediately
    });

    // Advance time past expiry
    const future = new Date(Date.now() + 5000);
    const count = expireOverdueTasks(db, future);

    expect(count).toBe(1);
    const updated = getTask(db, task.id);
    expect(updated!.status).toBe("expired");
  });

  it("does not expire tasks that haven't reached expires_at", () => {
    createApprovalTask(db, {
      sql: "SELECT 1",
      sqlHash: makeHash("SELECT 1"),
      connectionName: "c",
      statementType: "select",
      triggerRule: "test",
      ttlMs: 3600_000, // 1 hour — won't expire
    });

    const count = expireOverdueTasks(db, new Date());
    expect(count).toBe(0);
  });

  it("does not affect approved/denied/consumed tasks", () => {
    const t1 = createApprovalTask(db, {
      sql: "SELECT 1",
      sqlHash: makeHash("SELECT 1"),
      connectionName: "c",
      statementType: "select",
      triggerRule: "test",
      ttlMs: 1000,
    });
    approveTask(db, t1.id);

    const future = new Date(Date.now() + 5000);
    const count = expireOverdueTasks(db, future);
    expect(count).toBe(0);
    expect(getTask(db, t1.id)!.status).toBe("approved");
  });

  it("returns 0 when no tasks exist", () => {
    const count = expireOverdueTasks(db, new Date());
    expect(count).toBe(0);
  });

  it("expires multiple overdue tasks at once", () => {
    for (let i = 0; i < 5; i++) {
      createApprovalTask(db, {
        sql: `SELECT ${i}`,
        sqlHash: makeHash(`SELECT ${i}`),
        connectionName: "c",
        statementType: "select",
        triggerRule: "test",
        ttlMs: 1000,
      });
    }

    const future = new Date(Date.now() + 5000);
    const count = expireOverdueTasks(db, future);
    expect(count).toBe(5);
  });
});

describe("findAndConsumeApproved", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  it("returns modifiedSql and consumes the task", () => {
    const sql = "DROP TABLE users";
    const hash = makeHash(sql);
    const task = createApprovalTask(db, {
      sql,
      sqlHash: hash,
      connectionName: "c",
      statementType: "drop_table",
      triggerRule: "test",
    });
    approveTask(db, task.id, { modifiedSql: "DROP TABLE temp_users" });

    const result = findAndConsumeApproved(db, hash, "c");
    expect(result).not.toBeNull();
    expect(result!.modifiedSql).toBe("DROP TABLE temp_users");

    // Task should be consumed now
    expect(getTask(db, task.id)!.status).toBe("consumed");
  });

  it("returns null when no matching approved task exists", () => {
    const result = findAndConsumeApproved(db, "nonexistent-hash", "c");
    expect(result).toBeNull();
  });

  it("returns null for pending task (not yet approved)", () => {
    const hash = makeHash("DROP TABLE x");
    createApprovalTask(db, {
      sql: "DROP TABLE x",
      sqlHash: hash,
      connectionName: "c",
      statementType: "drop_table",
      triggerRule: "test",
    });

    const result = findAndConsumeApproved(db, hash, "c");
    expect(result).toBeNull();
  });

  it("returns null for consumed task (already used)", () => {
    const sql = "DROP TABLE y";
    const hash = makeHash(sql);
    const task = createApprovalTask(db, {
      sql,
      sqlHash: hash,
      connectionName: "c",
      statementType: "drop_table",
      triggerRule: "test",
    });
    approveTask(db, task.id);
    consumeTask(db, task.id);

    const result = findAndConsumeApproved(db, hash, "c");
    expect(result).toBeNull();
  });

  it("returns null for denied task", () => {
    const sql = "DROP TABLE z";
    const hash = makeHash(sql);
    const task = createApprovalTask(db, {
      sql,
      sqlHash: hash,
      connectionName: "c",
      statementType: "drop_table",
      triggerRule: "test",
    });
    denyTask(db, task.id);

    const result = findAndConsumeApproved(db, hash, "c");
    expect(result).toBeNull();
  });

  it("returns null when connection name doesn't match", () => {
    const hash = makeHash("DROP TABLE w");
    const task = createApprovalTask(db, {
      sql: "DROP TABLE w",
      sqlHash: hash,
      connectionName: "conn-a",
      statementType: "drop_table",
      triggerRule: "test",
    });
    approveTask(db, task.id);

    const result = findAndConsumeApproved(db, hash, "conn-b");
    expect(result).toBeNull();
  });

  it("returns modifiedSql as undefined when no modification was made", () => {
    const sql = "ALTER TABLE t ADD COLUMN x INT";
    const hash = makeHash(sql);
    const task = createApprovalTask(db, {
      sql,
      sqlHash: hash,
      connectionName: "c",
      statementType: "alter_table",
      triggerRule: "test",
    });
    approveTask(db, task.id); // no modifiedSql

    const result = findAndConsumeApproved(db, hash, "c");
    expect(result).not.toBeNull();
    expect(result!.modifiedSql).toBeUndefined();
  });

  it("prevents concurrent consume (atomic)", () => {
    const sql = "DROP TABLE atomic_test";
    const hash = makeHash(sql);
    const task = createApprovalTask(db, {
      sql,
      sqlHash: hash,
      connectionName: "c",
      statementType: "drop_table",
      triggerRule: "test",
    });
    approveTask(db, task.id);

    // First consume succeeds
    const result1 = findAndConsumeApproved(db, hash, "c");
    expect(result1).not.toBeNull();

    // Second consume returns null (task already consumed)
    const result2 = findAndConsumeApproved(db, hash, "c");
    expect(result2).toBeNull();
  });
});

describe("listPendingTasks", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  it("returns only pending tasks", () => {
    const t1 = createApprovalTask(db, {
      sql: "SELECT 1",
      sqlHash: makeHash("SELECT 1"),
      connectionName: "c",
      statementType: "select",
      triggerRule: "test",
    });
    const t2 = createApprovalTask(db, {
      sql: "SELECT 2",
      sqlHash: makeHash("SELECT 2"),
      connectionName: "c",
      statementType: "select",
      triggerRule: "test",
    });
    // Approve one — should not appear in pending list
    approveTask(db, t1.id);

    const pending = listPendingTasks(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(t2.id);
  });

  it("returns empty array when no pending tasks", () => {
    expect(listPendingTasks(db)).toEqual([]);
  });
});

describe("listRecentTasks", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  it("returns tasks within the limit", () => {
    const t1 = createApprovalTask(db, {
      sql: "SELECT 1",
      sqlHash: makeHash("SELECT 1"),
      connectionName: "c",
      statementType: "select",
      triggerRule: "test",
    });
    const t2 = createApprovalTask(db, {
      sql: "SELECT 2",
      sqlHash: makeHash("SELECT 2"),
      connectionName: "c",
      statementType: "select",
      triggerRule: "test",
    });

    const recent = listRecentTasks(db, 10);
    expect(recent).toHaveLength(2);
    // Both tasks should be present (order depends on created_at granularity)
    const ids = recent.map((t) => t.id);
    expect(ids).toContain(t1.id);
    expect(ids).toContain(t2.id);
  });

  it("respects the limit parameter", () => {
    for (let i = 0; i < 5; i++) {
      createApprovalTask(db, {
        sql: `SELECT ${i}`,
        sqlHash: makeHash(`SELECT ${i}`),
        connectionName: "c",
        statementType: "select",
        triggerRule: "test",
      });
    }

    const recent = listRecentTasks(db, 3);
    expect(recent).toHaveLength(3);
  });
});
