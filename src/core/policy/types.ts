/** Policy decision types (ADR-0008) */
export const DecisionKind = {
  Allow: "allow",
  Deny: "deny",
  NeedApproval: "need_approval",
} as const;

export type PolicyDecision =
  | { kind: typeof DecisionKind.Allow; modifiedSql?: string | undefined }
  | { kind: typeof DecisionKind.Deny; rule: string; reason: string }
  | { kind: typeof DecisionKind.NeedApproval; rule: string; reason: string };

/** Statement type classification for policy rules */
export type StatementType =
  | "select"
  | "insert"
  | "update"
  | "delete"
  | "create_table"
  | "create_index"
  | "create_view"
  | "create_database"
  | "drop_table"
  | "drop_index"
  | "drop_view"
  | "drop_database"
  | "drop_schema"
  | "alter_table"
  | "alter_database"
  | "rename_table"
  | "truncate"
  | "show_tables"
  | "show_databases"
  | "show_columns"
  | "show_create_table"
  | "use"
  | "set"
  | "call"
  | "grant"
  | "revoke"
  | "other";

/** Configuration for policy evaluation */
export interface PolicyConfig {
  allowedStatementTypes: StatementType[];
  needApprovalStatementTypes: StatementType[];
  blockedStatementTypes: StatementType[];
  enforceLimit: boolean;
  maxLimit: number;
}

/** Context passed to each policy rule */
export interface PolicyContext {
  sql: string;
  sqlHash: string;
  connection: { name: string; policy: PolicyConfig };
}

/** A single policy rule in the evaluation chain */
export interface PolicyRule {
  name: string;
  description: string;
  builtIn?: boolean;
  /** required=true rules cannot be disabled or reordered */
  required?: boolean;
  evaluate: (ast: AST, ctx: PolicyContext) => PolicyDecision | null;
}

/** AST type from node-sql-parser */
export type AST = any;
