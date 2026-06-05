/**
 * MCP Server — creates and configures the XM-SQL-MCP MCP server.
 *
 * Uses @modelcontextprotocol/sdk's McpServer high-level API.
 * Registers 6 tools (ADR-0010 + list_connections), each wrapped with withAudit middleware.
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
import { createListConnectionsHandler } from "./tools/list-connections.js";
import { createListTablesHandler } from "./tools/list-tables.js";

export interface McpServerDeps {
  /** Get the raw SQLite handle */
  getRawDb: () => BetterSqlite3.Database;
  /** Get the master key for decrypting connection passwords */
  getMasterKey: () => Buffer;
  /** Default connection name (from CLI args or env, project-level MCP config) */
  defaultConnection?: string;
  /** Default schema (from CLI args or env, project-level MCP config) */
  defaultSchema?: string;
}

/**
 * Create the XM-SQL-MCP MCP server with all 6 tools registered.
 *
 * @param deps - Dependencies for audit and connection resolution
 * @returns Configured McpServer instance (not yet connected to transport)
 */
export function createMcpServer(deps: McpServerDeps): McpServer {
  const mcp = new McpServer(
    { name: "xm-sql-mcp", version: "0.0.1" },
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

  // ─── Tool 0: list_connections ─────────────────────────────────
  // This MUST be the first tool AI sees — it discovers what's available.
  mcp.tool(
    "list_connections",
    "List all available database connections. " +
      "ALWAYS call this tool first before any other tool to discover available connection names. " +
      "Returns connection name, host, port, username, default schema, policy, and description for each connection.",
    {},
    withAudit(
      "list_connections",
      createListConnectionsHandler({
        getRawDb: deps.getRawDb,
        ...(deps.defaultConnection
          ? { defaultConnection: deps.defaultConnection }
          : {}),
        ...(deps.defaultSchema ? { defaultSchema: deps.defaultSchema } : {}),
      }),
    ),
  );

  // Dynamic connection description — injects default when configured
  const connDesc = deps.defaultConnection
    ? `Connection alias name. Default: "${deps.defaultConnection}"`
    : "Connection alias name (from list_connections)";

  // ─── Tool 1: execute_sql ───────────────────────────────────────
  mcp.tool(
    "execute_sql",
    "Execute a single SQL statement on a MySQL connection. " +
      "The statement is validated by the policy engine before execution. " +
      "DDL statements (CREATE TABLE, DROP TABLE, ALTER TABLE) may require approval. " +
      "CREATE/DROP/ALTER DATABASE are permanently blocked. " +
      "IMPORTANT: Use list_connections first to find the correct connection name.",
    {
      connection: z.string().describe(connDesc),
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
      "Useful for understanding query performance before executing. " +
      "IMPORTANT: Use list_connections first to find the correct connection name.",
    {
      connection: z.string().describe(connDesc),
      sql: z.string().min(1).describe("SQL statement to explain"),
    },
    withAudit("explain_sql", createExplainSqlHandler()),
  );

  // ─── Tool 3: list_tables ───────────────────────────────────────
  mcp.tool(
    "list_tables",
    "List all tables in the connection's default schema (or a specified schema). " +
      "Returns table name, type (TABLE/VIEW), and approximate row count. " +
      "IMPORTANT: Use list_connections first to find the correct connection name.",
    {
      connection: z.string().describe(connDesc),
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
    "Get the DDL (CREATE TABLE statement) and approximate row count for a table. " +
      "IMPORTANT: Use list_connections first to find the correct connection name.",
    {
      connection: z.string().describe(connDesc),
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
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "xm-sql-mcp", version: "0.0.1" },
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
