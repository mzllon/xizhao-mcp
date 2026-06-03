import type {
  AST,
  PolicyContext,
  PolicyDecision,
  PolicyRule,
} from "../types.js";
import { getStatementType } from "../statement-type.js";

/**
 * Rule 5: need-approval-statement-types
 *
 * Trigger approval workflow if the statement type requires it.
 */
export const needApprovalStatementTypes: PolicyRule = {
  name: "need-approval-statement-types",
  description: "Require approval for certain statement types",
  evaluate(ast: AST, ctx: PolicyContext): PolicyDecision | null {
    const { needApprovalStatementTypes: types } = ctx.connection.policy;
    const type = getStatementType(ast);
    if (types.includes(type)) {
      return {
        kind: "need_approval",
        rule: "need-approval-statement-types",
        reason: `Statement type "${type}" requires approval`,
      };
    }
    return null;
  },
};
