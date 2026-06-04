import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
/**
 * list_connections MCP tool handler.
 *
 * Returns all available connections (without passwords).
 * This is the discovery tool — AI should call this first
 * to learn what connection names are available.
 */
import type {
  ToolHandlerArgs,
  ToolHandlerContext,
} from "../middleware/audit.js";
import { listConnections } from "../../core/connection.js";
import { success } from "../response.js";

export interface ListConnectionsDeps {
  /** Get the raw SQLite handle */
  getRawDb: () => import("better-sqlite3").Database;
  /** Default connection name (from CLI args or env) */
  defaultConnection?: string;
  /** Default schema (from CLI args or env) */
  defaultSchema?: string;
}

export function createListConnectionsHandler(deps: ListConnectionsDeps) {
  return async (
    _args: ToolHandlerArgs,
    handlerCtx: ToolHandlerContext,
  ): Promise<CallToolResult> => {
    const db = deps.getRawDb();
    const connections = listConnections(db);
    return success(
      {
        ...(deps.defaultConnection || deps.defaultSchema
          ? {
              defaultConnection: deps.defaultConnection,
              defaultSchema: deps.defaultSchema,
            }
          : {}),
        connections: connections.map((c) => ({
          name: c.name,
          host: c.host,
          port: c.port,
          username: c.username,
          defaultSchema: c.defaultSchema,
          policy: c.policy,
          description: c.description,
        })),
      },
      handlerCtx.auditId,
    );
  };
}
