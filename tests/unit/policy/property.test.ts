import type { PolicyContext } from "../../../src/core/policy/types.js";
import crypto from "node:crypto";
import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { evaluate, POLICY_PRESETS } from "../../../src/core/policy/index.js";

function makeCtx(): PolicyContext {
  return {
    sql: "",
    sqlHash: crypto.createHash("sha256").update("test").digest("hex"),
    connection: { name: "test", policy: POLICY_PRESETS["dev-default"] },
  };
}

describe("policy property-based tests", () => {
  fcTest.prop({ sql: fc.string() })(
    "policy engine never throws on any string input",
    ({ sql }) => {
      expect(() => evaluate(sql, makeCtx())).not.toThrow();
    },
  );

  fcTest.prop({ sql: fc.string({ minLength: 1 }) })(
    "DROP DATABASE variants are always denied in dev-default",
    ({ sql }) => {
      if (/drop\s+database/i.test(sql)) {
        const result = evaluate(sql, makeCtx());
        expect(result.kind).toBe("deny");
      }
    },
  );

  fcTest.prop({ sql: fc.string({ minLength: 1 }) })(
    "GRANT statements are always denied in dev-default",
    ({ sql }) => {
      if (/^grant\s/i.test(sql)) {
        const result = evaluate(sql, makeCtx());
        expect(result.kind).toBe("deny");
      }
    },
  );

  it("returns a valid decision kind for various inputs", () => {
    const validKinds = new Set(["allow", "deny", "need_approval"]);
    const sqls = [
      "SELECT 1",
      "DROP TABLE x",
      "INSERT INTO x VALUES (1)",
      "TRUNCATE x",
      "CREATE TABLE x (id INT)",
      "GRANT ALL ON *.* TO a",
      "",
      "   ",
      "random text",
      "SELECT 1; SELECT 2",
    ];
    for (const sql of sqls) {
      const result = evaluate(sql, makeCtx());
      expect(validKinds.has(result.kind)).toBe(true);
    }
  });
});
