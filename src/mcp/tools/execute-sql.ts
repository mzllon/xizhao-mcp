import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
/**
 * execute_sql MCP tool handler.
 *
 * Full pipeline:
 *   1. Validate args (connection name, SQL)
 *   2. Resolve connection from storage
 *   3. Evaluate policy (allow / deny / need_approval)
 *   4. Execute SQL via mysql.ts
 *   5. Return structured result
 *
 * Audit is handled by withAudit middleware — handler focuses on business logic.
 */
import type { PolicyConfig } from "../../core/policy/types.js";
import type {
  ToolHandlerArgs,
  ToolHandlerContext,
} from "../middleware/audit.js";
import crypto from "node:crypto";
import { executeSql } from "../../core/mysql.js";
import { evaluate, parsePolicyConfig } from "../../core/policy/index.js";
import { XizhaoError } from "../../shared/errors.js";
import { success } from "../response.js";

/** SQL hash for policy context and approval dedup */
function sqlHash(sql: string): string {
  return crypto.createHash("sha256").update(sql.trim()).digest("hex");
}

export function createExecuteSqlHandler() {
  return async (
    args: ToolHandlerArgs,
    handlerCtx: ToolHandlerContext,
  ): Promise<CallToolResult> => {
    const connectionName = args.connection as string | undefined;
    const sql = args.sql as string | undefined;

    if (!connectionName) {
      throw new XizhaoError(
        "CONNECTION_NOT_FOUND",
        "Missing 'connection' argument",
      );
    }
    if (!sql) {
      throw new XizhaoError("SQL_PARSE_ERROR", "Missing 'sql' argument");
    }

    const conn = handlerCtx.conn;
    if (!conn) {
      throw new XizhaoError(
        "CONNECTION_NOT_FOUND",
        `Connection "${connectionName}" not found`,
      );
    }

    // Parse policy config from the connection
    const policyConfig: PolicyConfig = parsePolicyConfig(conn.policy);

    // Evaluate policy
    const policyStart = Date.now();
    const decision = evaluate(sql, {
      sql,
      sqlHash: sqlHash(sql),
      connection: { name: conn.name, policy: policyConfig },
    });
    const policyDurationMs = Date.now() - policyStart;

    if (decision.kind === "deny") {
      throw new XizhaoError("POLICY_VIOLATION", decision.reason, {
        rule: decision.rule,
      });
    }

    if (decision.kind === "need_approval") {
      throw new XizhaoError("NEED_APPROVAL", decision.reason, {
        rule: decision.rule,
        sql,
        sqlHash: sqlHash(sql),
        connectionName: conn.name,
        policyDurationMs,
      });
    }

    // decision.kind === "allow" — execute
    const effectiveSql = decision.modifiedSql ?? sql;
    const maxLimit = policyConfig.enforceLimit ? policyConfig.maxLimit : 10_000;

    const result = await executeSql(conn, effectiveSql, { maxLimit });

    return success(result, handlerCtx.auditId);
  };
}
