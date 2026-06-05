import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStorage } from "../../../src/core/storage.js";

const cleanupQueue: string[] = [];

afterEach(() => {
  for (const dir of cleanupQueue) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows WAL lock
    }
  }
  cleanupQueue.length = 0;
});

function setup() {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "xm-sql-mcp-migration-"),
  );
  cleanupQueue.push(tmpDir);
  return tmpDir;
}

describe("storage migration", () => {
  it("creates description column on fresh database", () => {
    const tmpDir = setup();
    const { raw, close } = openStorage(tmpDir);
    try {
      // description column should exist after migration
      const columns = raw.pragma("table_info(connections)") as {
        name: string;
      }[];
      const colNames = columns.map((c) => c.name);
      expect(colNames).toContain("description");
    } finally {
      close();
    }
  });

  it("is idempotent — opening storage twice does not fail", () => {
    const tmpDir = setup();
    // First open creates tables + adds columns
    const first = openStorage(tmpDir);
    first.close();

    // Second open should not throw on ALTER TABLE ADD COLUMN
    const second = openStorage(tmpDir);
    try {
      const columns = second.raw.pragma("table_info(connections)") as {
        name: string;
      }[];
      const colNames = columns.map((c) => c.name);
      expect(colNames).toContain("description");
    } finally {
      second.close();
    }
  });
});
