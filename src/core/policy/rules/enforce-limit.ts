import type {
  AST,
  PolicyContext,
  PolicyDecision,
  PolicyRule,
} from "../types.js";
import { getStatementType } from "../statement-type.js";

/**
 * Rule 7: enforce-limit
 *
 * For SELECT statements, require LIMIT and enforce a maximum value.
 */
export const enforceLimit: PolicyRule = {
  name: "enforce-limit",
  description: "Enforce LIMIT on SELECT statements",
  evaluate(ast: AST, ctx: PolicyContext): PolicyDecision | null {
    const { enforceLimit, maxLimit } = ctx.connection.policy;
    if (!enforceLimit) return null;

    const type = getStatementType(ast);
    if (type !== "select") return null;

    const limit = ast?.limit;
    if (!limit) {
      return {
        kind: "deny",
        rule: "enforce-limit",
        reason: `SELECT without LIMIT is not allowed. Add LIMIT ${maxLimit}.`,
      };
    }

    // node-sql-parser limit: { separator: '', value: [{ type: 'number', value: N }] }
    const limitValue = extractLimitValue(limit);
    if (limitValue !== null && limitValue > maxLimit) {
      return {
        kind: "deny",
        rule: "enforce-limit",
        reason: `LIMIT ${limitValue} exceeds maximum ${maxLimit}.`,
      };
    }

    return null;
  },
};

function extractLimitValue(limit: unknown): number | null {
  if (!limit || typeof limit !== "object") return null;
  const lim = limit as { value?: unknown[] };
  if (!Array.isArray(lim.value) || lim.value.length === 0) return null;
  const first = lim.value[0] as { type?: string; value?: unknown };
  if (first?.type === "number" && typeof first.value === "number")
    return first.value;
  return null;
}
