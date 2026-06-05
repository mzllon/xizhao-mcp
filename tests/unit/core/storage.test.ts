import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStorage } from "../../../src/core/storage.js";

/** Track temp dirs for cleanup after tests */
const cleanupQueue: string[] = [];

afterEach(() => {
  // Windows: WAL files may be locked, retry cleanup
  for (const dir of cleanupQueue) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Non-critical on Windows — temp dir will be cleaned by OS eventually
    }
  }
  cleanupQueue.length = 0;
});

describe("storage", () => {
  function createTmpDir(): string {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "xm-sql-mcp-storage-"),
    );
    cleanupQueue.push(tmpDir);
    return tmpDir;
  }

  describe("openStorage", () => {
    it("creates directory structure and database file", () => {
      const tmpDir = createTmpDir();
      const { paths, close } = openStorage(tmpDir);
      expect(fs.existsSync(paths.configDb)).toBe(true);
      expect(fs.existsSync(paths.logsDir)).toBe(true);
      close();
    });

    it("enables WAL mode", () => {
      const tmpDir = createTmpDir();
      const { raw, close } = openStorage(tmpDir);
      const result = raw.pragma("journal_mode") as { journal_mode: string }[];
      expect(result[0].journal_mode).toBe("wal");
      close();
    });

    it("sets busy_timeout to 5000", () => {
      const tmpDir = createTmpDir();
      const { raw, close } = openStorage(tmpDir);
      const result = raw.pragma("busy_timeout") as { timeout: number }[];
      expect(result[0].timeout).toBe(5000);
      close();
    });

    it("enables foreign keys", () => {
      const tmpDir = createTmpDir();
      const { raw, close } = openStorage(tmpDir);
      const result = raw.pragma("foreign_keys") as { foreign_keys: number }[];
      expect(result[0].foreign_keys).toBe(1);
      close();
    });

    it("migration is idempotent — open twice without error", () => {
      const tmpDir = createTmpDir();
      const s1 = openStorage(tmpDir);
      s1.close();
      const s2 = openStorage(tmpDir);
      s2.close();
      expect(true).toBe(true);
    });

    it("creates all required tables", () => {
      const tmpDir = createTmpDir();
      const { raw, close } = openStorage(tmpDir);
      const tables = raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all() as { name: string }[];
      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain("connections");
      expect(tableNames).toContain("audit_log");
      expect(tableNames).toContain("approval_tasks");
      close();
    });
  });
});
