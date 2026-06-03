import type {
  AST,
  PolicyContext,
  PolicyDecision,
  PolicyRule,
} from "../types.js";

/**
 * Rule 1: approved-task-override (required)
 *
 * If the SQL matches an approved (and unexpired) approval task,
 * auto-allow it. Optionally uses modifiedSql from the approval.
 */
export const approvedTaskOverride: PolicyRule = {
  name: "approved-task-override",
  description: "Allow SQL that matches a previously approved task",
  builtIn: true,
  required: true,
  evaluate(_ast: AST, _ctx: PolicyContext): PolicyDecision | null {
    // Full implementation requires DB access through ctx.db
    // Will be wired in stage-08 (approval workflow)
    return null;
  },
};
