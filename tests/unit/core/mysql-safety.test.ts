import type { Connection } from "../../../src/core/connection.js";
import { describe, expect, it } from "vitest";
import { executeSql, explainSql } from "../../../src/core/mysql.js";

/** Minimal Connection stub for testing — pool never actually connects */
function mockConn(): Connection {
  return {
    id: "test-id",
    name: "test-conn",
    host: "localhost",
    port: 3306,
    username: "root",
    password: "test",
    defaultSchema: "testdb",
    policy: "dev-default",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("executeSql hard-blocked statements", () => {
  it("blocks CREATE DATABASE", async () => {
    const conn = mockConn();
    await expect(
      executeSql(conn, "CREATE DATABASE evil_db", { maxLimit: 1000 }),
    ).rejects.toThrow("permanently blocked");
  });

  it("blocks CREATE DATABASE IF NOT EXISTS", async () => {
    const conn = mockConn();
    await expect(
      executeSql(conn, "CREATE DATABASE IF NOT EXISTS evil_db", {
        maxLimit: 1000,
      }),
    ).rejects.toThrow("permanently blocked");
  });

  it("blocks CREATE SCHEMA", async () => {
    const conn = mockConn();
    await expect(
      executeSql(conn, "CREATE SCHEMA evil_schema", { maxLimit: 1000 }),
    ).rejects.toThrow("permanently blocked");
  });

  it("blocks DROP DATABASE", async () => {
    const conn = mockConn();
    await expect(
      executeSql(conn, "DROP DATABASE important_db", { maxLimit: 1000 }),
    ).rejects.toThrow("permanently blocked");
  });

  it("blocks DROP DATABASE IF EXISTS", async () => {
    const conn = mockConn();
    await expect(
      executeSql(conn, "DROP DATABASE IF EXISTS important_db", {
        maxLimit: 1000,
      }),
    ).rejects.toThrow("permanently blocked");
  });

  it("blocks DROP SCHEMA", async () => {
    const conn = mockConn();
    await expect(
      executeSql(conn, "DROP SCHEMA important_schema", { maxLimit: 1000 }),
    ).rejects.toThrow("permanently blocked");
  });

  it("blocks ALTER DATABASE", async () => {
    const conn = mockConn();
    await expect(
      executeSql(conn, "ALTER DATABASE testdb CHARACTER SET utf8mb4", {
        maxLimit: 1000,
      }),
    ).rejects.toThrow("permanently blocked");
  });

  it("blocks statements with leading whitespace", async () => {
    const conn = mockConn();
    await expect(
      executeSql(conn, "   CREATE DATABASE evil_db", { maxLimit: 1000 }),
    ).rejects.toThrow("permanently blocked");
  });

  it("blocks statements with leading newlines", async () => {
    const conn = mockConn();
    await expect(
      executeSql(conn, "\n\nCREATE DATABASE evil_db", { maxLimit: 1000 }),
    ).rejects.toThrow("permanently blocked");
  });

  it("throws XmSqlMcpError with POLICY_VIOLATION code", async () => {
    const conn = mockConn();
    try {
      await executeSql(conn, "CREATE DATABASE evil_db", { maxLimit: 1000 });
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toHaveProperty("code", "POLICY_VIOLATION");
    }
  });
});

describe("explainSql hard-blocked statements", () => {
  it("blocks EXPLAIN CREATE DATABASE", async () => {
    const conn = mockConn();
    await expect(explainSql(conn, "CREATE DATABASE evil_db")).rejects.toThrow(
      "permanently blocked",
    );
  });

  it("blocks EXPLAIN DROP DATABASE", async () => {
    const conn = mockConn();
    await expect(
      explainSql(conn, "DROP DATABASE important_db"),
    ).rejects.toThrow("permanently blocked");
  });
});

describe("executeSql allows safe statements (no connection needed)", () => {
  // These will fail with a connection error (no MySQL), but should NOT
  // throw "permanently blocked" — that proves they pass the safety check.
  it("does NOT block CREATE TABLE", async () => {
    const conn = mockConn();
    await expect(
      executeSql(conn, "CREATE TABLE test (id INT)", { maxLimit: 1000 }),
    ).rejects.not.toThrow("permanently blocked");
  });

  it("does NOT block DROP TABLE", async () => {
    const conn = mockConn();
    await expect(
      executeSql(conn, "DROP TABLE test", { maxLimit: 1000 }),
    ).rejects.not.toThrow("permanently blocked");
  });

  it("does NOT block SELECT", async () => {
    const conn = mockConn();
    await expect(
      executeSql(conn, "SELECT 1", { maxLimit: 1000 }),
    ).rejects.not.toThrow("permanently blocked");
  });

  it("does NOT block INSERT", async () => {
    const conn = mockConn();
    await expect(
      executeSql(conn, "INSERT INTO test VALUES (1)", { maxLimit: 1000 }),
    ).rejects.not.toThrow("permanently blocked");
  });
});
