import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
/**
 * describe_table MCP tool handler.
 *
 * Returns DDL and approximate row count for a table.
 */
import type {
  ToolHandlerArgs,
  ToolHandlerContext,
} from "../middleware/audit.js";
import { describeTable } from "../../core/mysql.js";
import { XizhaoError } from "../../shared/errors.js";
import { success } from "../response.js";

export function createDescribeTableHandler() {
  return async (
    args: ToolHandlerArgs,
    handlerCtx: ToolHandlerContext,
  ): Promise<CallToolResult> => {
    const connectionName = args.connection as string | undefined;
    const table = args.table as string | undefined;

    if (!connectionName) {
      throw new XizhaoError(
        "CONNECTION_NOT_FOUND",
        "Missing 'connection' argument",
      );
    }
    if (!table) {
      throw new XizhaoError("SQL_PARSE_ERROR", "Missing 'table' argument");
    }

    const conn = handlerCtx.conn;
    if (!conn) {
      throw new XizhaoError(
        "CONNECTION_NOT_FOUND",
        `Connection "${connectionName}" not found`,
      );
    }

    const result = await describeTable(conn, table);

    return success(result, handlerCtx.auditId);
  };
}
