import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
/**
 * check_task_status MCP tool handler.
 *
 * Looks up an approval task by ID and returns its status.
 * This tool doesn't need a MySQL connection — it queries the local approval_tasks table.
 */
import type {
  ToolHandlerArgs,
  ToolHandlerContext,
} from "../middleware/audit.js";
import { getTask } from "../../core/approval.js";
import { XmSqlMcpError } from "../../shared/errors.js";
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
      throw new XmSqlMcpError("SQL_PARSE_ERROR", "Missing 'taskId' argument");
    }

    const db = deps.getRawDb();
    const task = getTask(db, taskId);

    if (!task) {
      throw new XmSqlMcpError(
        "CONNECTION_NOT_FOUND",
        `Task "${taskId}" not found`,
      );
    }

    return success(
      {
        taskId: task.id,
        status: task.status,
        connectionName: task.connectionName,
        sql: task.sql,
        statementType: task.statementType,
        triggerRule: task.triggerRule,
        expiresAt: task.expiresAt,
        decidedAt: task.decidedAt,
        deciderKind: task.deciderKind,
        modifiedSql: task.modifiedSql,
        decisionNote: task.decisionNote,
      },
      handlerCtx.auditId,
    );
  };
}
