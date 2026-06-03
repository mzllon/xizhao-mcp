import type {
  AST,
  PolicyContext,
  PolicyDecision,
  PolicyRule,
} from "../types.js";
import { getStatementType } from "../statement-type.js";

/**
 * Rule 6: block-statement-types
 *
 * Hard-deny certain statement types regardless of other rules.
 */
export const blockStatementTypes: PolicyRule = {
  name: "block-statement-types",
  description: "Block dangerous statement types",
  evaluate(ast: AST, ctx: PolicyContext): PolicyDecision | null {
    const { blockedStatementTypes } = ctx.connection.policy;
    const type = getStatementType(ast);
    if (blockedStatementTypes.includes(type)) {
      return {
        kind: "deny",
        rule: "block-statement-types",
        reason: `Statement type "${type}" is blocked by policy`,
      };
    }
    return null;
  },
};
