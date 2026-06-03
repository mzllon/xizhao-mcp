import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
/**
 * explain_sql MCP tool handler.
 *
 * Runs EXPLAIN FORMAT=JSON on a SQL statement and returns the execution plan.
 * Same connection resolution and error handling as execute_sql.
 */
import type {
  ToolHandlerArgs,
  ToolHandlerContext,
} from "../middleware/audit.js";
import { explainSql } from "../../core/mysql.js";
import { XizhaoError } from "../../shared/errors.js";
import { success } from "../response.js";

export function createExplainSqlHandler() {
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

    const result = await explainSql(conn, sql);

    return success(result, handlerCtx.auditId);
  };
}
