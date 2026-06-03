import type {
  AST,
  PolicyContext,
  PolicyDecision,
  PolicyRule,
} from "../types.js";
import { getStatementType } from "../statement-type.js";

/**
 * Rule 4: enforce-statement-types
 *
 * Deny if the statement type is not in the allowed list.
 * '<all>' in allowedStatementTypes means everything is allowed.
 */
export const enforceStatementTypes: PolicyRule = {
  name: "enforce-statement-types",
  description: "Only allow statement types in the allowed list",
  evaluate(ast: AST, ctx: PolicyContext): PolicyDecision | null {
    const { allowedStatementTypes } = ctx.connection.policy;
    if (
      allowedStatementTypes.includes(
        "<all>" as (typeof allowedStatementTypes)[0],
      )
    )
      return null;

    const type = getStatementType(ast);
    if (!allowedStatementTypes.includes(type)) {
      return {
        kind: "deny",
        rule: "enforce-statement-types",
        reason: `Statement type "${type}" is not allowed for connection "${ctx.connection.name}"`,
      };
    }
    return null;
  },
};
