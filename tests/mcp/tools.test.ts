/**
 * Unit tests for MCP tool handlers and middleware.
 *
 * Tests each tool's success/failure paths, audit logging,
 * and error formatting — all without a real MySQL instance.
 */
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConnection } from "../../src/core/connection.js";
import { createWithAudit } from "../../src/mcp/middleware/audit.js";
import { error, success } from "../../src/mcp/response.js";
import { createCheckTaskStatusHandler } from "../../src/mcp/tools/check-task-status.js";
import { createDescribeTableHandler } from "../../src/mcp/tools/describe-table.js";
import { createExecuteSqlHandler } from "../../src/mcp/tools/execute-sql.js";
import { createExplainSqlHandler } from "../../src/mcp/tools/explain-sql.js";
import { createListTablesHandler } from "../../src/mcp/tools/list-tables.js";

/** Create an in-memory test storage with schema migrated */
function createTestStorage() {
  const raw = new Database(":memory:");
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");

  // Run the same migration as openStorage
  const sql = [
    "CREATE TABLE IF NOT EXISTS connections (",
    "  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, host TEXT NOT NULL,",
    "  port INTEGER NOT NULL DEFAULT 3306, username TEXT NOT NULL,",
    "  password_enc TEXT NOT NULL, default_schema TEXT, policy TEXT NOT NULL,",
    "  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_used_at TEXT",
    ");",
    "CREATE TABLE IF NOT EXISTS audit_log (",
    "  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, mcp_client_id TEXT,",
    "  connection_name TEXT, tool_name TEXT NOT NULL, sql TEXT,",
    "  decision TEXT NOT NULL, trigger_rule TEXT, reason TEXT,",
    "  exec_status TEXT, mysql_error_code TEXT, row_count INTEGER,",
    "  truncated INTEGER DEFAULT 0, policy_duration_ms INTEGER,",
    "  exec_duration_ms INTEGER, prev_hash TEXT NOT NULL,",
    "  payload TEXT NOT NULL, hash TEXT NOT NULL",
    ");",
    "CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);",
    "CREATE TABLE IF NOT EXISTS approval_tasks (",
    "  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,",
    "  connection_name TEXT NOT NULL, sql TEXT NOT NULL, sql_hash TEXT NOT NULL,",
    "  statement_type TEXT NOT NULL, trigger_rule TEXT NOT NULL,",
    "  status TEXT NOT NULL, decided_at TEXT, decider_kind TEXT,",
    "  modified_sql TEXT, decision_note TEXT, audit_id TEXT",
    ");",
  ].join("\n");
  raw.exec(sql);

  return raw;
}

describe("mCP response helpers", () => {
  it("success() returns valid CallToolResult", () => {
    const result = success({ rows: 5 }, "audit-123");
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("text");

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.data).toEqual({ rows: 5 });
    expect(parsed.auditId).toBe("audit-123");
    expect(result.isError).toBeUndefined();
  });

  it("error() returns CallToolResult with isError=true", () => {
    const result = error("MYSQL_ERROR", "Table not found", "audit-456");
    expect(result.isError).toBe(true);

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error.code).toBe("MYSQL_ERROR");
    expect(parsed.error.message).toBe("Table not found");
    expect(parsed.auditId).toBe("audit-456");
  });

  it("error() includes detail when provided", () => {
    const result = error(
      "NEED_APPROVAL",
      "DDL requires approval",
      "audit-789",
      {
        taskId: "task-001",
        approvalUrl: "http://localhost:3000/approve/task-001",
      },
    );

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error.detail.taskId).toBe("task-001");
    expect(parsed.error.detail.approvalUrl).toContain("approve");
  });
});

describe("withAudit middleware", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestStorage();
  });

  afterEach(() => {
    db.close();
  });

  it("writes audit record on handler success", async () => {
    const withAudit = createWithAudit({
      getRawDb: () => db,
      getConnection: () => undefined,
    });

    const handler = withAudit("test_tool", async (_args, ctx) => {
      return success({ ok: true }, ctx.auditId);
    });

    const result = await handler({});

    // Verify response
    expect(result.isError).toBeUndefined();

    // Verify audit record was written
    const rows = db.prepare("SELECT * FROM audit_log").all() as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tool_name).toBe("test_tool");
    expect(rows[0]!.exec_status).toBe("success");
  });

  it("writes audit record on handler error", async () => {
    const withAudit = createWithAudit({
      getRawDb: () => db,
      getConnection: () => undefined,
    });

    const handler = withAudit("test_tool", async () => {
      throw new Error("Something went wrong");
    });

    const result = await handler({});

    // Error is caught and returned as error response
    expect(result.isError).toBe(true);

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error.code).toBe("INTERNAL_ERROR");

    // Audit still written
    const rows = db.prepare("SELECT * FROM audit_log").all() as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.exec_status).toBe("error");
  });

  it("resolves connection and passes to handler", async () => {
    const masterKey = crypto.randomBytes(32);
    createConnection(
      db,
      {
        name: "test-conn",
        host: "localhost",
        port: 3306,
        username: "root",
        password: "secret",
        policy: "dev-default",
      },
      masterKey,
    );

    const withAudit = createWithAudit({
      getRawDb: () => db,
      getConnection: (name: string) => {
        try {
          const row = db
            .prepare("SELECT * FROM connections WHERE name = ?")
            .get(name) as Record<string, unknown> | undefined;
          if (!row) return undefined;
          // For test purposes, return a minimal Connection object
          return {
            id: row.id as string,
            name: row.name as string,
            host: row.host as string,
            port: row.port as number,
            username: row.username as string,
            password: "secret",
            policy: row.policy as string,
            createdAt: row.created_at as string,
            updatedAt: row.updated_at as string,
          };
        } catch {
          return undefined;
        }
      },
    });

    let receivedConnName: string | undefined;
    const handler = withAudit("test_tool", async (_args, ctx) => {
      receivedConnName = ctx.conn?.name;
      return success({ ok: true }, ctx.auditId);
    });

    await handler({ connection: "test-conn" });

    expect(receivedConnName).toBe("test-conn");
  });

  it("returns CONNECTION_NOT_FOUND error when connection is missing", async () => {
    const withAudit = createWithAudit({
      getRawDb: () => db,
      getConnection: () => undefined,
    });

    const handler = withAudit("test_tool", async (_args, ctx) => {
      if (!ctx.conn) {
        const { XizhaoError } = await import("../../src/shared/errors.js");
        throw new XizhaoError("CONNECTION_NOT_FOUND", "Connection not found");
      }
      return success({ ok: true }, ctx.auditId);
    });

    const result = await handler({ connection: "nonexistent" });
    expect(result.isError).toBe(true);

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error.code).toBe("CONNECTION_NOT_FOUND");
  });
});

describe("check_task_status handler", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestStorage();
  });

  afterEach(() => {
    db.close();
  });

  it("returns task details for existing task", async () => {
    const now = new Date().toISOString();
    const expires = new Date(Date.now() + 3600_000).toISOString();

    db.prepare(
      `INSERT INTO approval_tasks
       (id, created_at, expires_at, connection_name, sql, sql_hash,
        statement_type, trigger_rule, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "task-001",
      now,
      expires,
      "test-conn",
      "CREATE TABLE foo (id INT)",
      crypto
        .createHash("sha256")
        .update("CREATE TABLE foo (id INT)")
        .digest("hex"),
      "create_table",
      "need-approval-statement-types",
      "pending",
    );

    const handler = createCheckTaskStatusHandler({ getRawDb: () => db });
    const result = await handler(
      { taskId: "task-001" },
      { auditId: "audit-test" },
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.data.taskId).toBe("task-001");
    expect(parsed.data.status).toBe("pending");
    expect(parsed.data.sql).toBe("CREATE TABLE foo (id INT)");
  });

  it("throws CONNECTION_NOT_FOUND for non-existent task", async () => {
    const handler = createCheckTaskStatusHandler({ getRawDb: () => db });
    await expect(
      handler({ taskId: "nonexistent" }, { auditId: "audit-test" }),
    ).rejects.toThrow('Task "nonexistent" not found');
  });

  it("throws SQL_PARSE_ERROR when taskId is missing", async () => {
    const handler = createCheckTaskStatusHandler({ getRawDb: () => db });
    await expect(handler({}, { auditId: "audit-test" })).rejects.toThrow(
      "Missing 'taskId' argument",
    );
  });
});

describe("execute_sql handler", () => {
  it("throws CONNECTION_NOT_FOUND when connection arg is missing", async () => {
    const handler = createExecuteSqlHandler();
    await expect(handler({}, { auditId: "audit-test" })).rejects.toThrow(
      "Missing 'connection' argument",
    );
  });

  it("throws SQL_PARSE_ERROR when sql arg is missing", async () => {
    const handler = createExecuteSqlHandler();
    await expect(
      handler({ connection: "test" }, { auditId: "audit-test" }),
    ).rejects.toThrow("Missing 'sql' argument");
  });

  it("throws CONNECTION_NOT_FOUND when connection not resolved", async () => {
    const handler = createExecuteSqlHandler();
    await expect(
      handler(
        { connection: "nonexistent", sql: "SELECT 1" },
        { auditId: "audit-test" },
      ),
    ).rejects.toThrow('Connection "nonexistent" not found');
  });
});

describe("explain_sql handler", () => {
  it("throws when connection is missing", async () => {
    const handler = createExplainSqlHandler();
    await expect(
      handler({ sql: "SELECT 1" }, { auditId: "audit-test" }),
    ).rejects.toThrow("Missing 'connection' argument");
  });

  it("throws when sql is missing", async () => {
    const handler = createExplainSqlHandler();
    await expect(
      handler({ connection: "test" }, { auditId: "audit-test" }),
    ).rejects.toThrow("Missing 'sql' argument");
  });
});

describe("list_tables handler", () => {
  it("throws when connection is missing", async () => {
    const handler = createListTablesHandler();
    await expect(handler({}, { auditId: "audit-test" })).rejects.toThrow(
      "Missing 'connection' argument",
    );
  });
});

describe("describe_table handler", () => {
  it("throws when connection is missing", async () => {
    const handler = createDescribeTableHandler();
    await expect(
      handler({ table: "users" }, { auditId: "audit-test" }),
    ).rejects.toThrow("Missing 'connection' argument");
  });

  it("throws when table is missing", async () => {
    const handler = createDescribeTableHandler();
    await expect(
      handler({ connection: "test" }, { auditId: "audit-test" }),
    ).rejects.toThrow("Missing 'table' argument");
  });
});
