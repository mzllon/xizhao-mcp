import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Drizzle schema for config.db.
 *
 * Tables: connections, audit_log, approval_tasks
 * No users / api_keys / sessions (v2 only)
 */

export const connections = sqliteTable("connections", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  host: text("host").notNull(),
  port: integer("port").notNull().default(3306),
  username: text("username").notNull(),
  /** AES-256-GCM encrypted password, base64(iv || tag || ciphertext) */
  passwordEnc: text("password_enc").notNull(),
  /** Default schema/database to use */
  defaultSchema: text("default_schema"),
  /** JSON policy config for this connection */
  policy: text("policy").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastUsedAt: text("last_used_at"),
});

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    createdAt: text("created_at").notNull(),
    /** MCP client info (e.g. "Claude Code / 1.0") */
    mcpClientId: text("mcp_client_id"),
    /** Connection alias used */
    connectionName: text("connection_name"),
    /** MCP tool name */
    toolName: text("tool_name").notNull(),
    /** Original SQL submitted */
    sql: text("sql"),
    /** Policy decision: allow | deny | need_approval | parse_error */
    decision: text("decision").notNull(),
    /** Rule that triggered the decision */
    triggerRule: text("trigger_rule"),
    /** Human-readable reason */
    reason: text("reason"),
    /** Execution status: success | error | timeout */
    execStatus: text("exec_status"),
    /** MySQL error code if applicable */
    mysqlErrorCode: text("mysql_error_code"),
    /** Rows affected or returned */
    rowCount: integer("row_count"),
    /** Whether result was truncated */
    truncated: integer("truncated", { mode: "boolean" }),
    /** Policy evaluation time in ms */
    policyDurationMs: integer("policy_duration_ms"),
    /** Execution time in ms */
    execDurationMs: integer("exec_duration_ms"),
    /** Previous record hash (hash chain) */
    prevHash: text("prev_hash").notNull(),
    /** JSON payload of all fields (for hash computation) */
    payload: text("payload").notNull(),
    /** SHA-256 hash of payload */
    hash: text("hash").notNull(),
  },
  (table) => [
    index("idx_audit_log_created_at").on(table.createdAt),
    index("idx_audit_log_connection").on(table.connectionName),
    index("idx_audit_log_decision").on(table.decision),
  ],
);

export const approvalTasks = sqliteTable(
  "approval_tasks",
  {
    id: text("id").primaryKey(),
    createdAt: text("created_at").notNull(),
    /** Default: created_at + 24h */
    expiresAt: text("expires_at").notNull(),
    /** Connection alias */
    connectionName: text("connection_name").notNull(),
    /** Original SQL */
    sql: text("sql").notNull(),
    /** SHA-256 of sql, for approved-task-override quick lookup */
    sqlHash: text("sql_hash").notNull(),
    /** Parsed statement type */
    statementType: text("statement_type").notNull(),
    /** Rule that triggered need_approval */
    triggerRule: text("trigger_rule").notNull(),
    /** pending | approved | denied | expired | consumed */
    status: text("status").notNull(),
    /** When the decision was made */
    decidedAt: text("decided_at"),
    /** v1: always 'web_user' */
    deciderKind: text("decider_kind"),
    /** Modified SQL if approver changed it */
    modifiedSql: text("modified_sql"),
    /** Free-text note from approver */
    decisionNote: text("decision_note"),
    /** audit_log.id of the approval action itself */
    auditId: text("audit_id"),
  },
  (table) => [
    index("idx_approval_tasks_sql_hash").on(
      table.sqlHash,
      table.connectionName,
      table.status,
    ),
    index("idx_approval_tasks_status").on(table.status, table.expiresAt),
  ],
);
