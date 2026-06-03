import type {
  PolicyConfig,
  PolicyContext,
} from "../../../src/core/policy/types.js";
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { evaluate, POLICY_PRESETS } from "../../../src/core/policy/index.js";

function makeCtx(policy: PolicyConfig): PolicyContext {
  return {
    sql: "",
    sqlHash: crypto.createHash("sha256").update("test").digest("hex"),
    connection: { name: "test-conn", policy },
  };
}

describe("evaluate", () => {
  const devDefault = POLICY_PRESETS["dev-default"];
  const readonlyStrict = POLICY_PRESETS["readonly-strict"];
  const demoLoose = POLICY_PRESETS["demo-loose"];

  describe("parse errors", () => {
    it("denies unparseable SQL", () => {
      const result = evaluate("NOT VALID SQL !!!@@@", makeCtx(devDefault));
      expect(result.kind).toBe("deny");
      if (result.kind === "deny") expect(result.rule).toBe("parse-error");
    });

    it("denies empty string", () => {
      const result = evaluate("", makeCtx(devDefault));
      expect(result.kind).toBe("deny");
    });

    it("denies random garbage", () => {
      const result = evaluate("))(((!!!", makeCtx(devDefault));
      expect(result.kind).toBe("deny");
    });
  });

  describe("multi-statement", () => {
    it("denies multiple statements", () => {
      const result = evaluate("SELECT 1; SELECT 2", makeCtx(devDefault));
      expect(result.kind).toBe("deny");
      if (result.kind === "deny") expect(result.rule).toBe("multi-statement");
    });
  });

  describe("dev-default preset", () => {
    it("allows simple SELECT with LIMIT", () => {
      const result = evaluate(
        "SELECT * FROM users LIMIT 10",
        makeCtx(devDefault),
      );
      expect(result.kind).toBe("allow");
    });

    it("allows INSERT", () => {
      const result = evaluate(
        'INSERT INTO users (name) VALUES ("test")',
        makeCtx(devDefault),
      );
      expect(result.kind).toBe("allow");
    });

    it("allows UPDATE", () => {
      const result = evaluate(
        'UPDATE users SET name = "new" WHERE id = 1',
        makeCtx(devDefault),
      );
      expect(result.kind).toBe("allow");
    });

    it("allows DELETE", () => {
      const result = evaluate(
        "DELETE FROM users WHERE id = 1",
        makeCtx(devDefault),
      );
      expect(result.kind).toBe("allow");
    });

    it("denies SELECT without LIMIT (enforceLimit)", () => {
      const result = evaluate("SELECT * FROM users", makeCtx(devDefault));
      expect(result.kind).toBe("deny");
      if (result.kind === "deny") expect(result.rule).toBe("enforce-limit");
    });

    it("denies SELECT with LIMIT exceeding maxLimit", () => {
      const result = evaluate(
        "SELECT * FROM users LIMIT 5000",
        makeCtx(devDefault),
      );
      expect(result.kind).toBe("deny");
      if (result.kind === "deny") expect(result.rule).toBe("enforce-limit");
    });

    it("denies DROP DATABASE (not in allowed types / blocked)", () => {
      const result = evaluate("DROP DATABASE testdb", makeCtx(devDefault));
      expect(result.kind).toBe("deny");
    });

    it("denies TRUNCATE (not in allowed types)", () => {
      const result = evaluate("TRUNCATE TABLE users", makeCtx(devDefault));
      expect(result.kind).toBe("deny");
    });

    it("denies GRANT", () => {
      const result = evaluate(
        'GRANT ALL ON *.* TO user@"localhost"',
        makeCtx(devDefault),
      );
      expect(result.kind).toBe("deny");
    });

    it("needs approval for CREATE TABLE", () => {
      const result = evaluate(
        "CREATE TABLE foo (id INT PRIMARY KEY)",
        makeCtx(devDefault),
      );
      expect(result.kind).toBe("need_approval");
    });

    it("needs approval for DROP TABLE", () => {
      const result = evaluate("DROP TABLE foo", makeCtx(devDefault));
      expect(result.kind).toBe("need_approval");
    });

    it("needs approval for ALTER TABLE", () => {
      const result = evaluate(
        "ALTER TABLE foo ADD COLUMN age INT",
        makeCtx(devDefault),
      );
      expect(result.kind).toBe("need_approval");
    });

    it("allows SHOW TABLES", () => {
      const result = evaluate("SHOW TABLES", makeCtx(devDefault));
      expect(result.kind).toBe("allow");
    });
  });

  describe("readonly-strict preset", () => {
    it("allows SELECT with LIMIT", () => {
      const result = evaluate(
        "SELECT * FROM users LIMIT 10",
        makeCtx(readonlyStrict),
      );
      expect(result.kind).toBe("allow");
    });

    it("denies INSERT", () => {
      const result = evaluate(
        'INSERT INTO users (name) VALUES ("test")',
        makeCtx(readonlyStrict),
      );
      expect(result.kind).toBe("deny");
      if (result.kind === "deny")
        expect(result.rule).toBe("enforce-statement-types");
    });

    it("denies UPDATE", () => {
      const result = evaluate(
        'UPDATE users SET name = "new" WHERE id = 1',
        makeCtx(readonlyStrict),
      );
      expect(result.kind).toBe("deny");
      if (result.kind === "deny")
        expect(result.rule).toBe("enforce-statement-types");
    });

    it("denies DELETE", () => {
      const result = evaluate(
        "DELETE FROM users WHERE id = 1",
        makeCtx(readonlyStrict),
      );
      expect(result.kind).toBe("deny");
      if (result.kind === "deny")
        expect(result.rule).toBe("enforce-statement-types");
    });

    it("denies SELECT without LIMIT", () => {
      const result = evaluate("SELECT * FROM users", makeCtx(readonlyStrict));
      expect(result.kind).toBe("deny");
      if (result.kind === "deny") expect(result.rule).toBe("enforce-limit");
    });

    it("denies SELECT with LIMIT exceeding 500", () => {
      const result = evaluate(
        "SELECT * FROM users LIMIT 501",
        makeCtx(readonlyStrict),
      );
      expect(result.kind).toBe("deny");
      if (result.kind === "deny") expect(result.rule).toBe("enforce-limit");
    });
  });

  describe("demo-loose preset", () => {
    it("allows SELECT without LIMIT", () => {
      const result = evaluate("SELECT * FROM users", makeCtx(demoLoose));
      expect(result.kind).toBe("allow");
    });

    it("allows INSERT", () => {
      const result = evaluate(
        'INSERT INTO users (name) VALUES ("test")',
        makeCtx(demoLoose),
      );
      expect(result.kind).toBe("allow");
    });

    it("needs approval for DROP DATABASE", () => {
      const result = evaluate("DROP DATABASE testdb", makeCtx(demoLoose));
      expect(result.kind).toBe("need_approval");
      if (result.kind === "need_approval")
        expect(result.rule).toBe("need-approval-statement-types");
    });

    it("needs approval for TRUNCATE", () => {
      const result = evaluate("TRUNCATE TABLE users", makeCtx(demoLoose));
      expect(result.kind).toBe("need_approval");
      if (result.kind === "need_approval")
        expect(result.rule).toBe("need-approval-statement-types");
    });
  });

  describe("never throws", () => {
    it("handles various inputs without throwing", () => {
      const inputs = [
        "",
        "  ",
        "null",
        "12345",
        "DROP",
        "SELECT",
        "-- comment",
        "/* block */",
        '"',
        "'",
        "\\",
        "\0",
        "\n",
        "SELECT * FROM",
        "1;2;3",
      ];
      for (const sql of inputs) {
        expect(() => evaluate(sql, makeCtx(devDefault))).not.toThrow();
      }
    });
  });
});
