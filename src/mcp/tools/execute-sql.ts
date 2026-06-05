import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
/**
 * execute_sql MCP tool handler.
 *
 * Full pipeline:
 *   1. Validate args (connection name, SQL)
 *   2. Resolve connection from storage
 *   3. Evaluate policy (allow / deny / need_approval)
 *   4a. If need_approval → create approval task, return NEED_APPROVAL error
 *   4b. If allow → execute SQL via mysql.ts
 *   5. Return structured result
 *
 * Audit is handled by withAudit middleware — handler focuses on business logic.
 */
import type BetterSqlite3 from "better-sqlite3";
import type { PolicyConfig } from "../../core/policy/types.js";
import type {
  ToolHandlerArgs,
  ToolHandlerContext,
} from "../middleware/audit.js";
import crypto from "node:crypto";
import { createApprovalTask } from "../../core/approval.js";
import { executeSql } from "../../core/mysql.js";
import { evaluate, parsePolicyConfig } from "../../core/policy/index.js";
import { XmSqlMcpError } from "../../shared/errors.js";
import { success } from "../response.js";

/** SQL hash for policy context and approval dedup */
function sqlHash(sql: string): string {
  return crypto.createHash("sha256").update(sql.trim()).digest("hex");
}

/** Dependencies for execute_sql handler */
export interface ExecuteSqlDeps {
  /** Get the raw SQLite handle (for creating approval tasks + policy context) */
  getRawDb: () => BetterSqlite3.Database;
}

export function createExecuteSqlHandler(deps: ExecuteSqlDeps) {
  return async (
    args: ToolHandlerArgs,
    handlerCtx: ToolHandlerContext,
  ): Promise<CallToolResult> => {
    const connectionName = args.connection as string | undefined;
    const sql = args.sql as string | undefined;

    if (!connectionName) {
      throw new XmSqlMcpError(
        "CONNECTION_NOT_FOUND",
        "Missing 'connection' argument",
      );
    }
    if (!sql) {
      throw new XmSqlMcpError("SQL_PARSE_ERROR", "Missing 'sql' argument");
    }

    const conn = handlerCtx.conn;
    if (!conn) {
      throw new XmSqlMcpError(
        "CONNECTION_NOT_FOUND",
        `Connection "${connectionName}" not found`,
      );
    }

    // Parse policy config from the connection
    const policyConfig: PolicyConfig = parsePolicyConfig(conn.policy);
    const hash = sqlHash(sql);

    // Evaluate policy — pass db so approved-task-override can consume approved tasks
    const decision = evaluate(sql, {
      sql,
      sqlHash: hash,
      connection: { name: conn.name, policy: policyConfig },
      db: deps.getRawDb(),
    });

    if (decision.kind === "deny") {
      throw new XmSqlMcpError("POLICY_VIOLATION", decision.reason, {
        rule: decision.rule,
      });
    }

    if (decision.kind === "need_approval") {
      // Create approval task and return NEED_APPROVAL error with task details
      const db = deps.getRawDb();
      const task = createApprovalTask(db, {
        sql,
        sqlHash: hash,
        connectionName: conn.name,
        statementType: decision.statementType ?? "other",
        triggerRule: decision.rule,
      });

      throw new XmSqlMcpError("NEED_APPROVAL", decision.reason, {
        taskId: task.id,
        triggerRule: decision.rule,
        triggerReason: decision.reason,
        approvalUrl: `http://localhost:9020/approve/${task.id}`,
        expiresAt: task.expiresAt,
      });
    }

    // decision.kind === "allow" — execute
    const effectiveSql = decision.modifiedSql ?? sql;
    const maxLimit = policyConfig.enforceLimit ? policyConfig.maxLimit : 10_000;

    const result = await executeSql(conn, effectiveSql, { maxLimit });

    return success(result, handlerCtx.auditId);
  };
}
