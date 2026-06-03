import type BetterSqlite3 from "better-sqlite3";
import fs from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getPaths } from "./app-paths.js";

export interface StorageHandle {
  db: ReturnType<typeof drizzle>;
  raw: BetterSqlite3.Database;
  paths: ReturnType<typeof getPaths>;
  close: () => void;
}

/**
 * Open (or create) the Xizhao config database.
 *
 * - Creates directory structure if missing
 * - Opens SQLite with WAL mode for concurrent access
 * - Runs schema migration via drizzle
 * - Returns a wrapped { db, close } handle
 */
export function openStorage(appDir?: string): StorageHandle {
  const paths = getPaths(appDir);

  // Ensure directory structure exists
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.mkdirSync(paths.logsDir, { recursive: true });

  // Open SQLite with WAL mode
  const raw = new Database(paths.configDb);
  raw.pragma("journal_mode = WAL");
  raw.pragma("busy_timeout = 5000");
  raw.pragma("foreign_keys = ON");
  raw.pragma("synchronous = NORMAL");

  // Run migration: create tables if not exist
  runMigration(raw);

  const db = drizzle(raw);

  return {
    db,
    raw,
    /** Get the resolved paths for this storage instance */
    paths,
    /** Safely close the SQLite handle */
    close: () => {
      raw.close();
    },
  };
}

/** Idempotent migration: create all tables if they don't exist */
function runMigration(db: Database.Database) {
  const sql = [
    "CREATE TABLE IF NOT EXISTS connections (",
    "  id              TEXT PRIMARY KEY,",
    "  name            TEXT NOT NULL UNIQUE,",
    "  host            TEXT NOT NULL,",
    "  port            INTEGER NOT NULL DEFAULT 3306,",
    "  username        TEXT NOT NULL,",
    "  password_enc    TEXT NOT NULL,",
    "  default_schema  TEXT,",
    "  policy          TEXT NOT NULL,",
    "  created_at      TEXT NOT NULL,",
    "  updated_at      TEXT NOT NULL,",
    "  last_used_at    TEXT",
    ");",
    "",
    "CREATE TABLE IF NOT EXISTS audit_log (",
    "  id                  TEXT PRIMARY KEY,",
    "  created_at          TEXT NOT NULL,",
    "  mcp_client_id       TEXT,",
    "  connection_name     TEXT,",
    "  tool_name           TEXT NOT NULL,",
    "  sql                 TEXT,",
    "  decision            TEXT NOT NULL,",
    "  trigger_rule        TEXT,",
    "  reason              TEXT,",
    "  exec_status         TEXT,",
    "  mysql_error_code    TEXT,",
    "  row_count           INTEGER,",
    "  truncated           INTEGER DEFAULT 0,",
    "  policy_duration_ms  INTEGER,",
    "  exec_duration_ms    INTEGER,",
    "  prev_hash           TEXT NOT NULL,",
    "  payload             TEXT NOT NULL,",
    "  hash                TEXT NOT NULL",
    ");",
    "",
    "CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);",
    "CREATE INDEX IF NOT EXISTS idx_audit_log_connection ON audit_log(connection_name);",
    "CREATE INDEX IF NOT EXISTS idx_audit_log_decision ON audit_log(decision);",
    "",
    "CREATE TABLE IF NOT EXISTS approval_tasks (",
    "  id              TEXT PRIMARY KEY,",
    "  created_at      TEXT NOT NULL,",
    "  expires_at      TEXT NOT NULL,",
    "  connection_name TEXT NOT NULL,",
    "  sql             TEXT NOT NULL,",
    "  sql_hash        TEXT NOT NULL,",
    "  statement_type  TEXT NOT NULL,",
    "  trigger_rule    TEXT NOT NULL,",
    "  status          TEXT NOT NULL,",
    "  decided_at      TEXT,",
    "  decider_kind    TEXT,",
    "  modified_sql    TEXT,",
    "  decision_note   TEXT,",
    "  audit_id        TEXT",
    ");",
    "",
    "CREATE INDEX IF NOT EXISTS idx_approval_tasks_sql_hash",
    "  ON approval_tasks(sql_hash, connection_name, status);",
    "CREATE INDEX IF NOT EXISTS idx_approval_tasks_status",
    "  ON approval_tasks(status, expires_at);",
  ].join("\n");

  db.exec(sql);
}
