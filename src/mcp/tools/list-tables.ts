import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
/**
 * list_tables MCP tool handler.
 *
 * Lists tables in the connection's default schema (or a specified schema).
 * Read-only, no policy evaluation needed (no SQL to parse).
 */
import type {
  ToolHandlerArgs,
  ToolHandlerContext,
} from "../middleware/audit.js";
import { listTables } from "../../core/mysql.js";
import { XmSqlMcpError } from "../../shared/errors.js";
import { success } from "../response.js";

export function createListTablesHandler() {
  return async (
    args: ToolHandlerArgs,
    handlerCtx: ToolHandlerContext,
  ): Promise<CallToolResult> => {
    const connectionName = args.connection as string | undefined;
    const schema = args.schema as string | undefined;

    if (!connectionName) {
      throw new XmSqlMcpError(
        "CONNECTION_NOT_FOUND",
        "Missing 'connection' argument",
      );
    }

    const conn = handlerCtx.conn;
    if (!conn) {
      throw new XmSqlMcpError(
        "CONNECTION_NOT_FOUND",
        `Connection "${connectionName}" not found`,
      );
    }

    const tables = await listTables(conn, schema);

    return success({ tables }, handlerCtx.auditId);
  };
}
