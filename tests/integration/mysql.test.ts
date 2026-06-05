/**
 * Integration tests for src/core/mysql.ts
 *
 * Requires a real MySQL instance. Connection info from environment:
 *   MYSQL_HOST (default: 192.168.10.2)
 *   MYSQL_PORT (default: 3306)
 *   MYSQL_USER (default: xm_sql_mcp_ai)
 *   MYSQL_PASSWORD (default: XM-SQL-MCP.123)
 *   MYSQL_DATABASE (default: xm_sql_mcp)
 *
 * Run: pnpm test:integration tests/integration/mysql.test.ts
 */
import type { Connection } from "../../src/core/connection.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  closeAllPools,
  closePool,
  describeTable,
  executeSql,
  explainSql,
  listTables,
} from "../../src/core/mysql.js";

const MYSQL_HOST = process.env.MYSQL_HOST ?? "192.168.10.2";
const MYSQL_PORT = Number(process.env.MYSQL_PORT ?? "3306");
const MYSQL_USER = process.env.MYSQL_USER ?? "xm_sql_mcp_ai";
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD ?? "XM-SQL-MCP.123";
const MYSQL_DATABASE = process.env.MYSQL_DATABASE ?? "xm-sql-mcp";

/** Table name prefix to identify our test tables for cleanup */
const TEST_PREFIX = "xm_sql_mcp_test_";

function testConn(): Connection {
  return {
    id: "test-id",
    name: `test-${Date.now()}`,
    host: MYSQL_HOST,
    port: MYSQL_PORT,
    username: MYSQL_USER,
    password: MYSQL_PASSWORD,
    defaultSchema: MYSQL_DATABASE,
    policy: "dev-default",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** Unique table name per test to avoid collisions */
function tableName(label: string): string {
  return `${TEST_PREFIX}${label}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

beforeAll(async () => {
  // Verify MySQL is reachable
  const conn = testConn();
  try {
    await executeSql(conn, "SELECT 1", { maxLimit: 10 });
  } catch {
    throw new Error(
      `Cannot connect to MySQL at ${MYSQL_HOST}:${MYSQL_PORT}/${MYSQL_DATABASE}. ` +
        "Ensure the test database and user are configured.",
    );
  }
});

afterEach(async () => {
  // Clean up any test tables we created
  const conn = testConn();
  try {
    const tables = await listTables(conn);
    for (const t of tables) {
      if (t.name.startsWith(TEST_PREFIX)) {
        await executeSql(conn, `DROP TABLE IF EXISTS \`${t.name}\``, {
          maxLimit: 10,
        });
      }
    }
  } catch {
    // Best-effort cleanup
  }
  await closeAllPools();
});

afterAll(async () => {
  await closeAllPools();
});

// ─── executeSql ────────────────────────────────────────────────

describe("executeSql", () => {
  it("executes SELECT and returns SelectResult", async () => {
    const conn = testConn();
    const result = await executeSql(
      conn,
      "SELECT CAST(42 AS SIGNED) AS num, 'hello' AS greeting",
      { maxLimit: 100 },
    );

    expect(result.kind).toBe("select");
    if (result.kind !== "select") return;
    expect(result.columns).toEqual(["num", "greeting"]);
    expect(result.rows).toHaveLength(1);
    // Note: numeric literals may be returned as strings due to BIGINT typeCast
    expect(Number(result.rows[0]!.num)).toBe(42);
    expect(result.rows[0]!.greeting).toBe("hello");
    expect(result.rowCount).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("executes CREATE TABLE and returns DdlResult", async () => {
    const conn = testConn();
    const tbl = tableName("ddl");
    const result = await executeSql(
      conn,
      `CREATE TABLE \`${tbl}\` (id INT PRIMARY KEY, name VARCHAR(100))`,
      { maxLimit: 10 },
    );

    expect(result.kind).toBe("ddl");
  });

  it("executes INSERT and returns ModifyResult", async () => {
    const conn = testConn();
    const tbl = tableName("insert");
    await executeSql(
      conn,
      `CREATE TABLE \`${tbl}\` (id INT PRIMARY KEY, name VARCHAR(100))`,
      { maxLimit: 10 },
    );

    const result = await executeSql(
      conn,
      `INSERT INTO \`${tbl}\` VALUES (1, 'Alice'), (2, 'Bob')`,
      { maxLimit: 10 },
    );

    expect(result.kind).toBe("modify");
    if (result.kind !== "modify") return;
    expect(result.affectedRows).toBe(2);
  });

  it("executes UPDATE and returns ModifyResult", async () => {
    const conn = testConn();
    const tbl = tableName("update");
    await executeSql(
      conn,
      `CREATE TABLE \`${tbl}\` (id INT PRIMARY KEY, name VARCHAR(100))`,
      { maxLimit: 10 },
    );
    await executeSql(conn, `INSERT INTO \`${tbl}\` VALUES (1, 'Alice')`, {
      maxLimit: 10,
    });

    const result = await executeSql(
      conn,
      `UPDATE \`${tbl}\` SET name = 'Bob' WHERE id = 1`,
      { maxLimit: 10 },
    );

    expect(result.kind).toBe("modify");
    if (result.kind !== "modify") return;
    expect(result.affectedRows).toBe(1);
  });

  it("executes DELETE and returns ModifyResult", async () => {
    const conn = testConn();
    const tbl = tableName("delete");
    await executeSql(
      conn,
      `CREATE TABLE \`${tbl}\` (id INT PRIMARY KEY, name VARCHAR(100))`,
      { maxLimit: 10 },
    );
    await executeSql(conn, `INSERT INTO \`${tbl}\` VALUES (1, 'Alice')`, {
      maxLimit: 10,
    });

    const result = await executeSql(
      conn,
      `DELETE FROM \`${tbl}\` WHERE id = 1`,
      {
        maxLimit: 10,
      },
    );

    expect(result.kind).toBe("modify");
    if (result.kind !== "modify") return;
    expect(result.affectedRows).toBe(1);
  });

  it("returns truncated=true when rows reach maxLimit", async () => {
    const conn = testConn();
    const tbl = tableName("trunc");
    await executeSql(conn, `CREATE TABLE \`${tbl}\` (id INT PRIMARY KEY)`, {
      maxLimit: 10,
    });
    // Insert 15 rows
    for (let i = 0; i < 15; i++) {
      await executeSql(conn, `INSERT INTO \`${tbl}\` VALUES (${i})`, {
        maxLimit: 10,
      });
    }

    // maxLimit only sets the truncated flag based on returned row count.
    // The policy engine enforces LIMIT — here we add it manually.
    const result = await executeSql(conn, `SELECT * FROM \`${tbl}\` LIMIT 10`, {
      maxLimit: 10,
    });

    expect(result.kind).toBe("select");
    if (result.kind !== "select") return;
    expect(result.rows).toHaveLength(10);
    expect(result.truncated).toBe(true);
  });

  it("returns MySQL error for invalid SQL", async () => {
    const conn = testConn();
    await expect(
      executeSql(conn, "SELECT * FROM nonexistent_table_xyz", { maxLimit: 10 }),
    ).rejects.toThrow();
  });

  it("hard-blocks CREATE DATABASE", async () => {
    const conn = testConn();
    await expect(
      executeSql(conn, "CREATE DATABASE evil_db", { maxLimit: 10 }),
    ).rejects.toThrow("permanently blocked");
  });

  it("hard-blocks DROP DATABASE", async () => {
    const conn = testConn();
    await expect(
      executeSql(conn, "DROP DATABASE xm_sql_mcp", { maxLimit: 10 }),
    ).rejects.toThrow("permanently blocked");
  });
});

// ─── explainSql ────────────────────────────────────────────────

describe("explainSql", () => {
  it("returns EXPLAIN plan as JSON object", async () => {
    const conn = testConn();
    const tbl = tableName("explain");
    await executeSql(
      conn,
      `CREATE TABLE \`${tbl}\` (id INT PRIMARY KEY, name VARCHAR(100))`,
      { maxLimit: 10 },
    );

    const result = await explainSql(conn, `SELECT * FROM \`${tbl}\``);

    expect(result.plan).toBeDefined();
    expect(typeof result.plan).toBe("object");
  });
});

// ─── listTables ────────────────────────────────────────────────

describe("listTables", () => {
  it("returns empty array for empty database", async () => {
    const conn = testConn();
    const tables = await listTables(conn);
    // May have leftover test tables from failed runs, filter
    const ours = tables.filter((t) => t.name.startsWith(TEST_PREFIX));
    expect(ours).toHaveLength(0);
  });

  it("returns created table", async () => {
    const conn = testConn();
    const tbl = tableName("list");
    await executeSql(conn, `CREATE TABLE \`${tbl}\` (id INT PRIMARY KEY)`, {
      maxLimit: 10,
    });

    const tables = await listTables(conn);
    const found = tables.find((t) => t.name === tbl);
    expect(found).toBeDefined();
    expect(found!.name).toBe(tbl);
    expect(found!.type).toContain("TABLE");
  });
});

// ─── describeTable ─────────────────────────────────────────────

describe("describeTable", () => {
  it("returns DDL and rowCount", async () => {
    const conn = testConn();
    const tbl = tableName("desc");
    await executeSql(
      conn,
      `CREATE TABLE \`${tbl}\` (id INT PRIMARY KEY, name VARCHAR(100) NOT NULL)`,
      { maxLimit: 10 },
    );
    await executeSql(conn, `INSERT INTO \`${tbl}\` VALUES (1, 'Alice')`, {
      maxLimit: 10,
    });

    const result = await describeTable(conn, tbl);

    expect(result.ddl).toContain("CREATE TABLE");
    expect(result.ddl).toContain("id");
    expect(result.ddl).toContain("name");
    // TABLE_ROWS from information_schema is BIGINT → string via typeCast
    expect(result.rowCount).toBeDefined();
  });
});

// ─── Pool management ───────────────────────────────────────────

describe("pool management", () => {
  it("closePool closes a specific pool", async () => {
    const conn = testConn();
    // Execute something to create the pool
    await executeSql(conn, "SELECT 1", { maxLimit: 10 });

    // closePool should succeed
    await closePool(conn.name);

    // After close, a new pool is created automatically
    const result = await executeSql(conn, "SELECT 1", { maxLimit: 10 });
    expect(result.kind).toBe("select");

    await closePool(conn.name);
  });

  it("closeAllPools closes all pools", async () => {
    const conn1 = testConn();
    const conn2 = testConn();
    await executeSql(conn1, "SELECT 1", { maxLimit: 10 });
    await executeSql(conn2, "SELECT 1", { maxLimit: 10 });

    await closeAllPools();

    // New connections work after closeAllPools
    const conn3 = testConn();
    const result = await executeSql(conn3, "SELECT 1", { maxLimit: 10 });
    expect(result.kind).toBe("select");

    await closeAllPools();
  });
});
