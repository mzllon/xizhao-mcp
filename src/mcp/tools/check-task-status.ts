import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
/**
 * check_task_status MCP tool handler.
 *
 * Looks up an approval task by ID and returns its status.
 * This tool doesn't need a connection — it queries the local approval_tasks table.
 * Full approval workflow (create/approve/reject) is implemented in Stage 08.
 */
import type {
  ToolHandlerArgs,
  ToolHandlerContext,
} from "../middleware/audit.js";
import { XizhaoError } from "../../shared/errors.js";
import { success } from "../response.js";

/** Dependencies for check_task_status — separate from AuditDeps */
export interface CheckTaskDeps {
  /** Get the raw SQLite handle */
  getRawDb: () => import("better-sqlite3").Database;
}

export function createCheckTaskStatusHandler(deps: CheckTaskDeps) {
  return async (
    args: ToolHandlerArgs,
    handlerCtx: ToolHandlerContext,
  ): Promise<CallToolResult> => {
    const taskId = args.taskId as string | undefined;

    if (!taskId) {
      throw new XizhaoError("SQL_PARSE_ERROR", "Missing 'taskId' argument");
    }

    const db = deps.getRawDb();
    const row = db
      .prepare(
        `SELECT id, status, connection_name, sql, statement_type, trigger_rule,
                expires_at, decided_at, decider_kind, modified_sql, decision_note
         FROM approval_tasks WHERE id = ?`,
      )
      .get(taskId) as Record<string, unknown> | undefined;

    if (!row) {
      throw new XizhaoError(
        "CONNECTION_NOT_FOUND",
        `Task "${taskId}" not found`,
      );
    }

    return success(
      {
        taskId: row.id as string,
        status: row.status as string,
        connectionName: row.connection_name as string,
        sql: row.sql as string,
        statementType: row.statement_type as string,
        triggerRule: row.trigger_rule as string,
        expiresAt: row.expires_at as string,
        decidedAt: (row.decided_at as string | null) ?? undefined,
        deciderKind: (row.decider_kind as string | null) ?? undefined,
        modifiedSql: (row.modified_sql as string | null) ?? undefined,
        decisionNote: (row.decision_note as string | null) ?? undefined,
      },
      handlerCtx.auditId,
    );
  };
}
