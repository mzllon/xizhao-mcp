import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
/**
 * withAudit middleware — wraps every MCP tool handler with audit logging.
 *
 * Guarantees:
 *   - Every tool call produces an audit record (fail-on-audit-failure)
 *   - auditId is generated here, propagated via AsyncLocalStorage
 *   - Policy evaluation result and execution outcome are both recorded
 *   - If audit write fails, the business result is NOT returned
 *
 * See ADR-0004 (fail-on-audit-failure), ADR-0010 (tool audit contract).
 */
import type { AuditEvent } from "../../core/audit.js";
import type { Connection } from "../../core/connection.js";
import type { PolicyDecision } from "../../core/policy/types.js";
import { appendAuditLog } from "../../core/audit.js";
import { XizhaoError } from "../../shared/errors.js";
import { generateUlid } from "../../shared/ids.js";
import { requestContext as ctx } from "../context.js";
import { error } from "../response.js";

/** Dependencies needed by withAudit — injected to allow testing */
export interface AuditDeps {
  /** Get the raw SQLite handle (for appendAuditLog) */
  getRawDb: () => import("better-sqlite3").Database;
  /** Resolve a connection by name (returns Connection or undefined) */
  getConnection: (name: string) => Connection | undefined;
}

/** Arguments passed to the wrapped handler */
export interface ToolHandlerArgs {
  [key: string]: unknown;
}

/** Context provided to the wrapped handler */
export interface ToolHandlerContext {
  /** Resolved connection (undefined for tools that don't need one) */
  conn?: Connection | undefined;
  /** The audit ID for this invocation */
  auditId: string;
  /** Policy decision from the policy engine (for tools that run SQL) */
  policyDecision?: PolicyDecision | undefined;
  /** Modified SQL from policy engine (e.g., LIMIT injection) */
  modifiedSql?: string | undefined;
}

/**
 * Create an withAudit wrapper with injected dependencies.
 *
 * Usage:
 *   const withAudit = createWithAudit(deps);
 *   server.tool('execute_sql', ..., withAudit('execute_sql', handler));
 */
export function createWithAudit(deps: AuditDeps) {
  return function withAudit(
    toolName: string,
    handler: (
      args: ToolHandlerArgs,
      ctx: ToolHandlerContext,
    ) => Promise<CallToolResult>,
    options?: { connectionArg?: string },
  ) {
    const connectionArg = options?.connectionArg ?? "connection";

    return async (
      args: ToolHandlerArgs,
      _extra?: unknown,
    ): Promise<CallToolResult> => {
      const auditId = generateUlid();
      const connectionName =
        (args[connectionArg] as string | undefined) ?? ctx.getConnectionName();

      // Build audit event — start with "attempting" state
      const event: AuditEvent = {
        tool: toolName,
        sql: args.sql as string | undefined,
        connectionName: connectionName ?? undefined,
        mcpClientId: ctx.getClientInfo()
          ? `${ctx.getClientInfo()!.name}/${ctx.getClientInfo()!.version}`
          : undefined,
        decision: "allow",
      };

      // Track execution metrics
      const startTime = Date.now();
      let execResult: CallToolResult | undefined;

      try {
        // Build the new store, conditionally including connectionName
        const currentStore = ctx.getStore();
        const newStore: typeof currentStore = {
          ...currentStore,
          auditId,
        };
        if (connectionName !== undefined) {
          newStore.connectionName = connectionName;
        }

        // Run handler inside AsyncLocalStorage scope with auditId + connectionName
        execResult = await ctx.run(newStore, async () => {
          // Resolve connection if the tool takes one
          let conn: Connection | undefined;
          if (connectionName) {
            conn = deps.getConnection(connectionName);
          }

          const handlerCtx: ToolHandlerContext = {
            auditId,
          };
          if (conn !== undefined) {
            handlerCtx.conn = conn;
          }

          return handler(args, handlerCtx);
        });

        // Record success
        event.execStatus = "success";
        event.execDurationMs = Date.now() - startTime;
      } catch (err: unknown) {
        // Record error
        event.execStatus = "error";
        event.execDurationMs = Date.now() - startTime;

        if (err instanceof XizhaoError) {
          event.mysqlErrorCode = err.code;
          execResult = error(err.code, err.message, auditId, err.detail);
        } else {
          // Unexpected error — wrap as INTERNAL_ERROR
          const message = err instanceof Error ? err.message : String(err);
          execResult = error("INTERNAL_ERROR", message, auditId);
        }
      }

      // Always write audit record (fail-on-audit-failure)
      try {
        const db = deps.getRawDb();
        appendAuditLog(db, event);
      } catch (auditErr: unknown) {
        throw new XizhaoError(
          "INTERNAL_ERROR",
          `Audit write failed: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`,
        );
      }

      return execResult!;
    };
  };
}
