/**
 * MCP Server — creates and configures the Xizhao MCP server.
 *
 * Uses @modelcontextprotocol/sdk's McpServer high-level API.
 * Registers 5 tools (ADR-0010), each wrapped with withAudit middleware.
 *
 * Key constraints:
 *   - stdout is exclusively for MCP JSON-RPC (never console.log)
 *   - All logging goes to stderr via pino
 *   - Tool schemas defined with Zod, exported via zod-to-json-schema
 */
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type BetterSqlite3 from "better-sqlite3";
import type { Connection } from "../core/connection.js";
import type { AuditDeps } from "./middleware/audit.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InitializeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getConnection } from "../core/connection.js";
import { requestContext } from "./context.js";
import { createWithAudit } from "./middleware/audit.js";
import { createCheckTaskStatusHandler } from "./tools/check-task-status.js";
import { createDescribeTableHandler } from "./tools/describe-table.js";
import { createExecuteSqlHandler } from "./tools/execute-sql.js";
import { createExplainSqlHandler } from "./tools/explain-sql.js";
import { createListTablesHandler } from "./tools/list-tables.js";

export interface McpServerDeps {
  /** Get the raw SQLite handle */
  getRawDb: () => BetterSqlite3.Database;
  /** Get the master key for decrypting connection passwords */
  getMasterKey: () => Buffer;
}

/**
 * Create the Xizhao MCP server with all 5 tools registered.
 *
 * @param deps - Dependencies for audit and connection resolution
 * @returns Configured McpServer instance (not yet connected to transport)
 */
export function createMcpServer(deps: McpServerDeps): McpServer {
  const mcp = new McpServer(
    { name: "xizhao", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  // Build the withAudit wrapper with injected dependencies
  const auditDeps: AuditDeps = {
    getRawDb: deps.getRawDb,
    getConnection: (name: string): Connection | undefined => {
      try {
        return getConnection(deps.getRawDb(), name, deps.getMasterKey());
      } catch {
        return undefined;
      }
    },
  };
  const withAudit = createWithAudit(auditDeps);

  // ─── Tool 1: execute_sql ───────────────────────────────────────
  mcp.tool(
    "execute_sql",
    "Execute a single SQL statement on a MySQL connection. " +
      "The statement is validated by the policy engine before execution. " +
      "DDL statements (CREATE TABLE, DROP TABLE, ALTER TABLE) may require approval. " +
      "CREATE/DROP/ALTER DATABASE are permanently blocked.",
    {
      connection: z.string().describe("Connection alias name"),
      sql: z.string().min(1).describe("Single SQL statement to execute"),
    },
    withAudit(
      "execute_sql",
      createExecuteSqlHandler({ getRawDb: deps.getRawDb }),
    ),
  );

  // ─── Tool 2: explain_sql ───────────────────────────────────────
  mcp.tool(
    "explain_sql",
    "Get the MySQL execution plan for a SQL statement using EXPLAIN FORMAT=JSON. " +
      "Useful for understanding query performance before executing.",
    {
      connection: z.string().describe("Connection alias name"),
      sql: z.string().min(1).describe("SQL statement to explain"),
    },
    withAudit("explain_sql", createExplainSqlHandler()),
  );

  // ─── Tool 3: list_tables ───────────────────────────────────────
  mcp.tool(
    "list_tables",
    "List all tables in the connection's default schema (or a specified schema). " +
      "Returns table name, type (TABLE/VIEW), and approximate row count.",
    {
      connection: z.string().describe("Connection alias name"),
      schema: z
        .string()
        .optional()
        .describe("Schema name (defaults to connection's default schema)"),
    },
    withAudit("list_tables", createListTablesHandler()),
  );

  // ─── Tool 4: describe_table ────────────────────────────────────
  mcp.tool(
    "describe_table",
    "Get the DDL (CREATE TABLE statement) and approximate row count for a table.",
    {
      connection: z.string().describe("Connection alias name"),
      table: z.string().describe("Table name"),
    },
    withAudit("describe_table", createDescribeTableHandler()),
  );

  // ─── Tool 5: check_task_status ─────────────────────────────────
  const checkTaskDeps = {
    getRawDb: deps.getRawDb,
  };
  mcp.tool(
    "check_task_status",
    "Check the status of an approval task. " +
      "When a SQL statement requires approval (e.g., DDL), the execute_sql tool returns " +
      "a NEED_APPROVAL error with a taskId. Use this tool to check if the task has been approved.",
    {
      taskId: z
        .string()
        .describe(
          "The task ID returned by execute_sql when approval is needed",
        ),
    },
    withAudit(
      "check_task_status",
      createCheckTaskStatusHandler(checkTaskDeps),
      { connectionArg: "taskId" },
    ),
  );

  // Capture clientInfo from initialize request into AsyncLocalStorage
  mcp.server.setRequestHandler(InitializeRequestSchema, async (request) => {
    const clientInfo = request.params.clientInfo;
    if (clientInfo) {
      await requestContext.run({ clientInfo }, async () => {
        // noop — just sets the store for this scope
      });
    }
    return {
      capabilities: { tools: {} },
      serverInfo: { name: "xizhao", version: "0.0.1" },
    };
  });

  return mcp;
}

/**
 * Connect the MCP server to a transport and start listening.
 */
export async function connectMcpServer(
  mcp: McpServer,
  transport: Transport,
): Promise<void> {
  await mcp.connect(transport);
}
