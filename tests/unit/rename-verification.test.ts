/**
 * Rename verification tests — prove the xizhao → xm-sql-mcp rename is complete.
 *
 * These tests target the specific rename points that could silently break
 * if a sed replacement was missed or partial.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(
  fs.readFileSync(
    path.resolve(import.meta.dirname, "../../package.json"),
    "utf-8",
  ),
);

describe("rename verification: xizhao → xm-sql-mcp", () => {
  it("package.json name is xm-sql-mcp", () => {
    expect(pkg.name).toBe("xm-sql-mcp");
    expect(pkg.name).not.toContain("xizhao");
  });

  it("package.json bin is xm-sql-mcp", () => {
    expect(pkg.bin["xm-sql-mcp"]).toBe("./dist/cli/index.js");
    expect(Object.keys(pkg.bin)).not.toContain("xizhao");
  });

  it("package.json repository URLs use xm-sql-mcp", () => {
    const repo = pkg.repository.url;
    expect(repo).toContain("xm-sql-mcp");
    expect(repo).not.toContain("xizhao-mcp");
  });

  it("xmSqlMcpError class exists and has correct name", async () => {
    const { XmSqlMcpError } = await import("../../src/shared/errors.js");
    const err = new XmSqlMcpError("TEST_CODE", "test message");
    expect(err.name).toBe("XmSqlMcpError");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("TEST_CODE");
  });

  it("no XizhaoError export remains in errors module", async () => {
    const errors = await import("../../src/shared/errors.js");
    const exports = Object.keys(errors);
    expect(exports).not.toContain("XizhaoError");
    expect(exports).toContain("XmSqlMcpError");
  });

  it("config directory default is .xm-sql-mcp", async () => {
    const { getPaths } = await import("../../src/core/app-paths.js");
    const orig = process.env.XM_SQL_MCP_HOME;
    delete process.env.XM_SQL_MCP_HOME;
    try {
      const paths = getPaths();
      expect(paths.dir).toContain("xm-sql-mcp");
      expect(paths.dir).not.toContain("xizhao");
    } finally {
      if (orig !== undefined) process.env.XM_SQL_MCP_HOME = orig;
    }
  });

  it("no 'xizhao' string remains in source files", () => {
    const result = execSync('grep -r "xizhao" --include="*.ts" src/ || true', {
      encoding: "utf-8",
      cwd: path.resolve(import.meta.dirname, "../.."),
    });
    // Only allow xm-sql-mcp which contains "sql-mcp" not "xizhao"
    const lines = result.trim().split("\n").filter(Boolean);
    const violations = lines.filter(
      (l) => !l.includes("xm-sql-mcp") && !l.includes("XmSqlMcp"),
    );
    expect(violations).toEqual([]);
  });
});
