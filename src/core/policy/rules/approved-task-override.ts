import type {
  AST,
  PolicyContext,
  PolicyDecision,
  PolicyRule,
} from "../types.js";
import { findAndConsumeApproved } from "../../approval.js";

/**
 * Rule 1: approved-task-override (required)
 *
 * If the SQL matches an approved (and unexpired) approval task,
 * auto-allow it. Optionally uses modifiedSql from the approval.
 *
 * The consume is atomic (same SQLite transaction) to prevent replay —
 * two concurrent requests cannot both use the same approved task.
 */
export const approvedTaskOverride: PolicyRule = {
  name: "approved-task-override",
  description: "Allow SQL that matches a previously approved task",
  builtIn: true,
  required: true,
  evaluate(_ast: AST, ctx: PolicyContext): PolicyDecision | null {
    if (!ctx.db) return null;

    const result = findAndConsumeApproved(
      ctx.db,
      ctx.sqlHash,
      ctx.connection.name,
    );
    if (!result) return null;

    return {
      kind: "allow",
      modifiedSql: result.modifiedSql,
    };
  },
};
