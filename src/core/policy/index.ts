import type {
  PolicyConfig,
  PolicyContext,
  PolicyDecision,
  PolicyRule,
  StatementType,
} from "./types.js";
import nodeSqlParser from "node-sql-parser";
import { approvedTaskOverride } from "./rules/approved-task-override.js";
import { blockStatementTypes } from "./rules/block-statement-types.js";
import { enforceLimit } from "./rules/enforce-limit.js";
import { enforceStatementTypes } from "./rules/enforce-statement-types.js";
import { checkMultiStatement } from "./rules/multi-statement.js";
import { needApprovalStatementTypes } from "./rules/need-approval-statement-types.js";

const { Parser } = nodeSqlParser;

const parser = new Parser();

/** Rule chain: order matters. Required rules (1-3) first, then configurable rules (4-7). */
export const RULES: PolicyRule[] = [
  approvedTaskOverride,
  enforceStatementTypes,
  needApprovalStatementTypes,
  blockStatementTypes,
  enforceLimit,
];

/**
 * Evaluate SQL against the policy engine.
 *
 * 1. Parse SQL into AST
 * 2. Check parse errors (Rule 2) and multi-statement (Rule 3)
 * 3. Run rule chain for remaining rules
 * 4. Default to allow if no rule matched
 */
export function evaluate(sql: string, ctx: PolicyContext): PolicyDecision {
  // Parse — node-sql-parser v5 wraps result in { ast: ... }
  let stmts: unknown[];
  try {
    const result = parser.parse(sql, { database: "MySQL" });
    // v5: { ast: AST | AST[] } — extract the actual AST
    const ast = result?.ast ?? result;
    stmts = Array.isArray(ast) ? ast : [ast];
  } catch (e: unknown) {
    return {
      kind: "deny",
      rule: "parse-error",
      reason: `SQL parse failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Rule 3: multi-statement
  const multiDecision = checkMultiStatement(stmts);
  if (multiDecision) return multiDecision;

  const ast = stmts[0];

  // Rule chain (4-7)
  for (const rule of RULES) {
    const decision = rule.evaluate(ast, ctx);
    if (decision !== null) return decision;
  }

  // No rule matched — allow
  return { kind: "allow" };
}

/** Policy presets (ADR-0008) */
export const POLICY_PRESETS: Record<string, PolicyConfig> = {
  "dev-default": {
    allowedStatementTypes: [
      "select",
      "insert",
      "update",
      "delete",
      "create_table",
      "create_index",
      "drop_table",
      "alter_table",
      "drop_index",
      "show_tables",
      "show_columns",
      "show_create_table",
    ] as StatementType[],
    needApprovalStatementTypes: [
      "create_table",
      "drop_table",
      "alter_table",
      "create_index",
      "drop_index",
    ] as StatementType[],
    blockedStatementTypes: [
      "drop_database",
      "drop_schema",
      "truncate",
      "grant",
      "revoke",
      "call",
      "create_database",
      "alter_database",
    ] as StatementType[],
    enforceLimit: true,
    maxLimit: 1000,
  },
  "readonly-strict": {
    allowedStatementTypes: [
      "select",
      "show_tables",
      "show_columns",
      "show_create_table",
    ] as StatementType[],
    needApprovalStatementTypes: [] as StatementType[],
    blockedStatementTypes: [
      "drop_database",
      "drop_schema",
      "truncate",
      "grant",
      "revoke",
      "call",
      "create_database",
      "alter_database",
    ] as StatementType[],
    enforceLimit: true,
    maxLimit: 500,
  },
  "demo-loose": {
    allowedStatementTypes: ["<all>"] as unknown as StatementType[],
    needApprovalStatementTypes: [
      "drop_database",
      "drop_schema",
      "truncate",
    ] as StatementType[],
    blockedStatementTypes: [] as StatementType[],
    enforceLimit: false,
    maxLimit: 100,
  },
};

/** Parse a PolicyConfig from JSON string (stored in connections table) */
export function parsePolicyConfig(policyJson: string): PolicyConfig {
  const raw = JSON.parse(policyJson) as Record<string, unknown>;
  const preset = raw.preset as string | undefined;
  if (preset && POLICY_PRESETS[preset]) {
    const base = POLICY_PRESETS[preset];
    return { ...base, ...raw } as PolicyConfig;
  }
  return raw as unknown as PolicyConfig;
}
