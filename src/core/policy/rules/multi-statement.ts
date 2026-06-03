import type { PolicyDecision } from "../types.js";

/**
 * Rule 3: multi-statement (required)
 *
 * Deny if the SQL contains multiple statements.
 * Checked at the parse level before rule chain.
 */
export function checkMultiStatement(stmts: unknown[]): PolicyDecision | null {
  if (stmts.length === 0) {
    return { kind: "deny", rule: "empty-input", reason: "Empty SQL input" };
  }
  if (stmts.length > 1) {
    return {
      kind: "deny",
      rule: "multi-statement",
      reason: `Multiple statements (${stmts.length}) are not allowed. Only one statement per request.`,
    };
  }
  return null;
}
