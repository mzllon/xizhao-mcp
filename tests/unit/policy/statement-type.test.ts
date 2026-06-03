import { Parser } from "node-sql-parser";
import { describe, expect, it } from "vitest";
import { getStatementType } from "../../../src/core/policy/statement-type.js";

const parser = new Parser();

function parse(sql: string) {
  const result = parser.parse(sql, { database: "MySQL" });
  // v5 wraps in { ast: ... }
  const ast = result?.ast ?? result;
  return Array.isArray(ast) ? ast[0] : ast;
}

describe("getStatementType", () => {
  describe("dML", () => {
    it("identifies SELECT", () => {
      expect(getStatementType(parse("SELECT * FROM users LIMIT 10"))).toBe(
        "select",
      );
    });

    it("identifies SELECT with JOIN", () => {
      expect(
        getStatementType(
          parse(
            "SELECT u.* FROM users u JOIN orders o ON u.id = o.user_id LIMIT 10",
          ),
        ),
      ).toBe("select");
    });

    it("identifies INSERT", () => {
      expect(
        getStatementType(parse('INSERT INTO users (name) VALUES ("test")')),
      ).toBe("insert");
    });

    it("identifies UPDATE", () => {
      expect(
        getStatementType(parse('UPDATE users SET name = "test" WHERE id = 1')),
      ).toBe("update");
    });

    it("identifies DELETE", () => {
      expect(getStatementType(parse("DELETE FROM users WHERE id = 1"))).toBe(
        "delete",
      );
    });
  });

  describe("dDL", () => {
    it("identifies CREATE TABLE", () => {
      expect(
        getStatementType(parse("CREATE TABLE foo (id INT PRIMARY KEY)")),
      ).toBe("create_table");
    });

    it("identifies CREATE INDEX", () => {
      expect(
        getStatementType(parse("CREATE INDEX idx_name ON users (name)")),
      ).toBe("create_index");
    });

    it("identifies DROP TABLE", () => {
      expect(getStatementType(parse("DROP TABLE users"))).toBe("drop_table");
    });

    it("identifies DROP DATABASE", () => {
      expect(getStatementType(parse("DROP DATABASE testdb"))).toBe(
        "drop_database",
      );
    });

    it("identifies ALTER TABLE", () => {
      expect(
        getStatementType(parse("ALTER TABLE users ADD COLUMN age INT")),
      ).toBe("alter_table");
    });

    it("identifies TRUNCATE", () => {
      expect(getStatementType(parse("TRUNCATE TABLE users"))).toBe("truncate");
    });
  });

  describe("utility", () => {
    it("identifies SHOW TABLES", () => {
      expect(getStatementType(parse("SHOW TABLES"))).toBe("show_tables");
    });

    it("identifies USE", () => {
      expect(getStatementType(parse("USE testdb"))).toBe("use");
    });
  });

  describe("dangerous", () => {
    it("identifies GRANT", () => {
      expect(
        getStatementType(parse('GRANT ALL ON *.* TO user@"localhost"')),
      ).toBe("grant");
    });
  });

  describe("edge cases", () => {
    it("returns other for null input", () => {
      expect(getStatementType(null)).toBe("other");
    });

    it("returns other for undefined input", () => {
      expect(getStatementType(undefined)).toBe("other");
    });

    it("returns other for empty object", () => {
      expect(getStatementType({})).toBe("other");
    });
  });
});
