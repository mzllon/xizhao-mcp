import type { FieldPacket, Pool, RowDataPacket } from "mysql2/promise";
import type { Connection } from "./connection.js";
import mysql from "mysql2/promise";
import { XmSqlMcpError } from "../shared/errors.js";

/** Timeout hint for SELECT queries (milliseconds) */
const SELECT_TIMEOUT_MS = 5000;

/** Timeout for DML/DDL queries (milliseconds) */
const QUERY_TIMEOUT_MS = 5000;

/** Pool configuration constants (ADR-0012) */
const POOL_CONNECTION_LIMIT = 5;
const POOL_QUEUE_LIMIT = 10;
const POOL_CONNECT_TIMEOUT = 10_000;

// ─── Result types ──────────────────────────────────────────────

export interface SelectResult {
  kind: "select";
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}

export interface ModifyResult {
  kind: "modify";
  affectedRows: number;
}

export interface DdlResult {
  kind: "ddl";
  durationMs: number;
}

export type SqlResult = SelectResult | ModifyResult | DdlResult;

export interface ExplainResult {
  plan: unknown;
}

export interface TableInfo {
  name: string;
  type: string;
  rowCount?: number | undefined;
}

export interface TableDescription {
  ddl: string;
  rowCount?: number | undefined;
}

// ─── Pool management ───────────────────────────────────────────

const pools = new Map<string, Pool>();

/** Get or create a MySQL connection pool for the given connection. */
export function getPool(conn: Connection): Pool {
  const existing = pools.get(conn.name);
  if (existing) return existing;

  const poolOptions: mysql.PoolOptions = {
    host: conn.host,
    port: conn.port,
    user: conn.username,
    password: conn.password,
    connectionLimit: POOL_CONNECTION_LIMIT,
    queueLimit: POOL_QUEUE_LIMIT,
    waitForConnections: true,
    connectTimeout: POOL_CONNECT_TIMEOUT,
    enableKeepAlive: true,
    timezone: "Z",
    dateStrings: false,
    typeCast(field, next) {
      // LONGLONG = BIGINT → string to avoid JS precision loss
      if (field.type === "LONGLONG") {
        const val = field.string();
        return val !== null ? val : next();
      }
      return next();
    },
  };
  if (conn.defaultSchema !== undefined) {
    poolOptions.database = conn.defaultSchema;
  }

  const pool = mysql.createPool(poolOptions);

  pools.set(conn.name, pool);
  return pool;
}

/** Close a specific connection pool by name. */
export async function closePool(connName: string): Promise<void> {
  const pool = pools.get(connName);
  if (pool) {
    pools.delete(connName);
    await pool.end();
  }
}

/** Close all connection pools. Used during graceful shutdown. */
export async function closeAllPools(): Promise<void> {
  const all = [...pools.values()];
  pools.clear();
  await Promise.all(all.map((p) => p.end()));
}

// ─── Helpers ───────────────────────────────────────────────────

/**
 * Statements that are hard-blocked at the execution layer.
 *
 * This is a defense-in-depth measure: even if the policy engine (Stage 04)
 * is bypassed or misconfigured, these statements can NEVER reach MySQL.
 * Rationale: CREATE/DROP/ALTER DATABASE affect the entire server instance,
 * not just a single connection's scope — too dangerous for any automated tool.
 *
 * See ADR-0013 (hard-blocked statements at execution layer).
 */
const BLOCKED_SQL_PATTERNS: RegExp[] = [
  /^\s*CREATE\s+(DATABASE|SCHEMA)\b/i,
  /^\s*DROP\s+(DATABASE|SCHEMA)\b/i,
  /^\s*ALTER\s+DATABASE\b/i,
];

/** Hard-block dangerous SQL statements at the execution layer. */
function assertSqlSafe(sql: string): void {
  for (const pattern of BLOCKED_SQL_PATTERNS) {
    if (pattern.test(sql)) {
      throw new XmSqlMcpError(
        "POLICY_VIOLATION",
        "CREATE/DROP/ALTER DATABASE is permanently blocked at the execution layer. This operation cannot be performed.",
      );
    }
  }
}

/** Classify a MySQL error into a XmSqlMcpError */
function classifyMySqlError(err: unknown): never {
  if (err instanceof XmSqlMcpError) throw err;

  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string })?.code;

  // Timeout detection
  if (
    code === "PROTOCOL_SEQUENCE_TIMEOUT" ||
    msg.includes("MAX_EXECUTION_TIME") ||
    msg.includes("Query execution was interrupted")
  ) {
    throw new XmSqlMcpError("TIMEOUT", "Query exceeded 5 second timeout");
  }

  throw new XmSqlMcpError("MYSQL_ERROR", msg, {
    mysqlCode: code ?? "UNKNOWN",
  });
}

/** Add MAX_EXECUTION_TIME hint to a SELECT query */
function addTimeoutHint(sql: string): string {
  return `/*+ MAX_EXECUTION_TIME(${SELECT_TIMEOUT_MS}) */ ${sql}`;
}

/** Detect if a SQL statement is a SELECT (for hint injection) */
function isSelectLike(sql: string): boolean {
  const trimmed = sql.trimStart().toUpperCase();
  return trimmed.startsWith("SELECT") || trimmed.startsWith("(SELECT");
}

/** Extract column names from field packets */
function extractColumns(fields: FieldPacket[]): string[] {
  return fields.map((f) => f.name);
}

// ─── executeSql ────────────────────────────────────────────────

export interface ExecuteOptions {
  maxLimit: number;
}

/**
 * Execute a single SQL statement and return a structured result.
 *
 * - SELECT queries get a 5s MAX_EXECUTION_TIME hint (MySQL engine-enforced)
 * - Non-SELECT queries use a Promise.race timeout (application-enforced)
 * - Results exceeding maxLimit are truncated
 */
export async function executeSql(
  conn: Connection,
  sql: string,
  options: ExecuteOptions,
): Promise<SqlResult> {
  const pool = getPool(conn);
  const start = Date.now();

  // Hard-block dangerous statements before they reach MySQL
  assertSqlSafe(sql);

  try {
    const selectLike = isSelectLike(sql);
    const finalSql = selectLike ? addTimeoutHint(sql) : sql;

    if (selectLike) {
      // SELECT: MySQL engine handles timeout via hint
      const [result, fields] = await pool.query(finalSql);
      return formatResult(result, fields, options.maxLimit, start);
    }

    // DML/DDL: application-level timeout via Promise.race
    const queryPromise = pool.query(finalSql);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new XmSqlMcpError("TIMEOUT", "Query exceeded 5 second timeout"),
          ),
        QUERY_TIMEOUT_MS,
      ),
    );

    const [result, fields] = await Promise.race([queryPromise, timeoutPromise]);
    return formatResult(result, fields, options.maxLimit, start);
  } catch (err) {
    classifyMySqlError(err);
  }
}

/** Format raw MySQL result into SqlResult */
function formatResult(
  result: unknown,
  fields: FieldPacket[],
  maxLimit: number,
  startTime: number,
): SqlResult {
  const durationMs = Date.now() - startTime;

  // SELECT: mysql2 returns an array of RowDataPacket
  if (Array.isArray(result)) {
    const rows = result as Record<string, unknown>[];
    const columns = extractColumns(fields);
    const truncated = rows.length >= maxLimit;
    return {
      kind: "select",
      columns,
      rows,
      rowCount: rows.length,
      truncated,
    };
  }

  // ResultSetHeader: both DML and DDL return this object
  const header = result as { affectedRows?: number; changedRows?: number };

  // DML (INSERT/UPDATE/DELETE): affectedRows > 0
  // DDL (CREATE TABLE/DROP TABLE): affectedRows === 0
  if (typeof header.affectedRows === "number" && header.affectedRows > 0) {
    return { kind: "modify", affectedRows: header.affectedRows };
  }

  // DDL or other non-row operations
  return { kind: "ddl", durationMs };
}

// ─── explainSql ────────────────────────────────────────────────

/**
 * Run EXPLAIN FORMAT=JSON on a SQL statement.
 * Returns the raw MySQL JSON execution plan.
 */
export async function explainSql(
  conn: Connection,
  sql: string,
): Promise<ExplainResult> {
  const pool = getPool(conn);

  // Hard-block even for EXPLAIN — no reason to explain a CREATE DATABASE
  assertSqlSafe(sql);

  try {
    const explainSql = `EXPLAIN FORMAT=JSON ${sql}`;
    const [rows] =
      await pool.query<(RowDataPacket & { EXPLAIN: string })[]>(explainSql);

    if (rows.length === 0) {
      throw new XmSqlMcpError("MYSQL_ERROR", "EXPLAIN returned no result");
    }

    const plan = JSON.parse(rows[0]!.EXPLAIN);
    return { plan };
  } catch (err) {
    classifyMySqlError(err);
  }
}

// ─── listTables ────────────────────────────────────────────────

/**
 * List tables in the given schema (or the connection's default schema).
 * No caching (ADR-0012).
 */
export async function listTables(
  conn: Connection,
  schema?: string,
): Promise<TableInfo[]> {
  const pool = getPool(conn);
  const dbName = schema ?? conn.defaultSchema;

  try {
    const [rows] = await pool.query<
      (RowDataPacket & {
        TABLE_NAME: string;
        TABLE_TYPE: string;
        TABLE_ROWS: number | null;
      })[]
    >(
      `SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS
       FROM information_schema.tables
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME`,
      [dbName],
    );

    return rows.map((row) => ({
      name: row.TABLE_NAME,
      type: row.TABLE_TYPE,
      rowCount: row.TABLE_ROWS ?? undefined,
    }));
  } catch (err) {
    classifyMySqlError(err);
  }
}

// ─── describeTable ─────────────────────────────────────────────

/**
 * Get the DDL and approximate row count for a table.
 * Uses SHOW CREATE TABLE + information_schema.
 */
export async function describeTable(
  conn: Connection,
  table: string,
): Promise<TableDescription> {
  const pool = getPool(conn);

  try {
    // SHOW CREATE TABLE returns columns: Table, Create Table (or View, Create View)
    const [ddlRows] = await pool.query<
      (RowDataPacket & Record<string, string>)[]
    >(`SHOW CREATE TABLE ??`, [table]);

    if (ddlRows.length === 0) {
      throw new XmSqlMcpError(
        "MYSQL_ERROR",
        `Table "${table}" not found or no access`,
      );
    }

    // Second column contains the DDL regardless of exact column name
    const ddl = Object.values(ddlRows[0]!)[1]!;

    // Get approximate row count
    const dbName = conn.defaultSchema;
    const [countRows] = await pool.query<
      (RowDataPacket & { TABLE_ROWS: number | null })[]
    >(
      `SELECT TABLE_ROWS
       FROM information_schema.tables
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [dbName, table],
    );

    return {
      ddl,
      rowCount: countRows[0]?.TABLE_ROWS ?? undefined,
    };
  } catch (err) {
    classifyMySqlError(err);
  }
}
