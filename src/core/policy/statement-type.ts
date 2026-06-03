import type { AST, StatementType } from "./types.js";

/**
 * Map node-sql-parser v5 AST to a StatementType.
 *
 * v5 AST structure (MySQL):
 * - ast.type: 'select' | 'insert' | 'update' | 'delete' | 'create' | 'drop' | 'alter' | 'truncate' | 'show' | 'use' | 'grant' | 'revoke' | ...
 * - For create/drop/alter/truncate/show: ast.keyword distinguishes sub-types
 */
export function getStatementType(ast: AST): StatementType {
  const type = ast?.type as string | undefined;
  if (!type) return "other";

  switch (type) {
    case "select":
      return "select";
    case "insert":
      return "insert";
    case "update":
      return "update";
    case "delete":
      return "delete";
    case "use":
      return "use";
    case "set":
      return "set";
    case "call":
      return "call";
    case "grant":
      return "grant";
    case "revoke":
      return "revoke";
    case "truncate":
      return "truncate";
    case "rename":
      return "rename_table";
    case "create": {
      const keyword = ast.keyword as string | undefined;
      switch (keyword) {
        case "table":
          return "create_table";
        case "index":
          return "create_index";
        case "view":
          return "create_view";
        case "database":
          return "create_database";
        default:
          return "other";
      }
    }
    case "drop": {
      const keyword = ast.keyword as string | undefined;
      switch (keyword) {
        case "table":
          return "drop_table";
        case "index":
          return "drop_index";
        case "view":
          return "drop_view";
        case "database":
          return "drop_database";
        case "schema":
          return "drop_schema";
        default:
          return "other";
      }
    }
    case "alter": {
      // ALTER TABLE in v5 has no keyword — check table[0] existence
      const table = ast.table as unknown[] | undefined;
      if (Array.isArray(table) && table.length > 0) return "alter_table";
      return "other";
    }
    case "show": {
      const keyword = ast.keyword as string | undefined;
      switch (keyword) {
        case "tables":
          return "show_tables";
        case "databases":
          return "show_databases";
        case "columns":
          return "show_columns";
        case "create":
          return "show_create_table";
        default:
          return "show_tables";
      }
    }
    default:
      return "other";
  }
}
