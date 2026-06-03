import type { AuditEvent, AuditRecord } from "../../../src/core/audit.js";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendAuditLog, verifyAuditChain } from "../../../src/core/audit.js";
import { openStorage } from "../../../src/core/storage.js";

const cleanupQueue: string[] = [];

afterEach(() => {
  for (const dir of cleanupQueue) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Non-critical on Windows — WAL files may be locked
    }
  }
  cleanupQueue.length = 0;
});

function createTmpStorage() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xizhao-audit-"));
  cleanupQueue.push(tmpDir);
  const { raw, close } = openStorage(tmpDir);
  return { db: raw, close };
}

function makeEvent(overrides?: Partial<AuditEvent>): AuditEvent {
  return {
    tool: "execute_sql",
    sql: "SELECT 1",
    connectionName: "test-conn",
    mcpClientId: "claude-code",
    decision: "allow",
    triggerRule: undefined,
    reason: undefined,
    policyDurationMs: 5,
    execStatus: "success",
    rowCount: 1,
    truncated: false,
    execDurationMs: 10,
    ...overrides,
  };
}

describe("appendAuditLog", () => {
  it("writes a record with correct fields", () => {
    const { db, close } = createTmpStorage();
    try {
      const event = makeEvent();
      const record = appendAuditLog(db, event);

      expect(record.id).toBeTruthy();
      expect(record.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(record.tool).toBe("execute_sql");
      expect(record.sql).toBe("SELECT 1");
      expect(record.connectionName).toBe("test-conn");
      expect(record.mcpClientId).toBe("claude-code");
      expect(record.decision).toBe("allow");
      expect(record.execStatus).toBe("success");
      expect(record.rowCount).toBe(1);
      expect(record.truncated).toBe(0);
      expect(record.policyDurationMs).toBe(5);
      expect(record.execDurationMs).toBe(10);

      // Genesis record has zero prevHash
      expect(record.prevHash).toBe("0".repeat(64));
      expect(record.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(record.payload).toBeTruthy();
    } finally {
      close();
    }
  });

  it("persists the record to SQLite", () => {
    const { db, close } = createTmpStorage();
    try {
      const event = makeEvent();
      appendAuditLog(db, event);

      const row = db.prepare("SELECT * FROM audit_log").get() as Record<
        string,
        unknown
      >;
      expect(row).toBeDefined();
      expect(row.tool_name).toBe("execute_sql");
      expect(row.sql).toBe("SELECT 1");
      expect(row.decision).toBe("allow");
    } finally {
      close();
    }
  });

  it("handles null optional fields", () => {
    const { db, close } = createTmpStorage();
    try {
      const event: AuditEvent = {
        tool: "execute_sql",
        decision: "deny",
      };
      const record = appendAuditLog(db, event);

      expect(record.sql).toBeNull();
      expect(record.connectionName).toBeNull();
      expect(record.mcpClientId).toBeNull();
      expect(record.triggerRule).toBeNull();
      expect(record.reason).toBeNull();
      expect(record.execStatus).toBeNull();
      expect(record.mysqlErrorCode).toBeNull();
      expect(record.rowCount).toBeNull();
      expect(record.truncated).toBe(0);
      expect(record.policyDurationMs).toBeNull();
      expect(record.execDurationMs).toBeNull();
    } finally {
      close();
    }
  });

  it("sets truncated=1 when event.truncated is true", () => {
    const { db, close } = createTmpStorage();
    try {
      const event = makeEvent({ truncated: true });
      const record = appendAuditLog(db, event);
      expect(record.truncated).toBe(1);
    } finally {
      close();
    }
  });

  it("computes hash from payload correctly", () => {
    const { db, close } = createTmpStorage();
    try {
      const event = makeEvent();
      const record = appendAuditLog(db, event);

      const expectedHash = crypto
        .createHash("sha256")
        .update(record.payload)
        .digest("hex");
      expect(record.hash).toBe(expectedHash);
    } finally {
      close();
    }
  });

  it("throws AUDIT_WRITE_FAILED on database error", () => {
    const { db, close } = createTmpStorage();
    close();

    // db is closed — any write should fail
    const event = makeEvent();
    expect(() => appendAuditLog(db, event)).toThrow("AUDIT_WRITE_FAILED");
  });
});

describe("hash chain", () => {
  it("links records with prevHash", () => {
    const { db, close } = createTmpStorage();
    try {
      const r1 = appendAuditLog(db, makeEvent({ sql: "SELECT 1" }));
      const r2 = appendAuditLog(db, makeEvent({ sql: "SELECT 2" }));
      const r3 = appendAuditLog(db, makeEvent({ sql: "SELECT 3" }));

      // Genesis: prevHash is zero
      expect(r1.prevHash).toBe("0".repeat(64));
      // Each subsequent record links to previous hash
      expect(r2.prevHash).toBe(r1.hash);
      expect(r3.prevHash).toBe(r2.hash);
    } finally {
      close();
    }
  });

  it("maintains complete chain for 100 consecutive records", () => {
    const { db, close } = createTmpStorage();
    try {
      const records: AuditRecord[] = [];
      for (let i = 0; i < 100; i++) {
        records.push(appendAuditLog(db, makeEvent({ sql: `SELECT ${i}` })));
      }

      // Verify chain linkage
      expect(records[0].prevHash).toBe("0".repeat(64));
      for (let i = 1; i < records.length; i++) {
        expect(records[i].prevHash).toBe(records[i - 1].hash);
      }
    } finally {
      close();
    }
  });

  it("verifyAuditChain returns valid for intact chain", () => {
    const { db, close } = createTmpStorage();
    try {
      for (let i = 0; i < 10; i++) {
        appendAuditLog(db, makeEvent({ sql: `SELECT ${i}` }));
      }

      const result = verifyAuditChain(db);
      expect(result.valid).toBe(true);
      expect(result.totalRecords).toBe(10);
      expect(result.brokenAt).toBeUndefined();
    } finally {
      close();
    }
  });

  it("verifyAuditChain returns valid for empty table", () => {
    const { db, close } = createTmpStorage();
    try {
      const result = verifyAuditChain(db);
      expect(result.valid).toBe(true);
      expect(result.totalRecords).toBe(0);
    } finally {
      close();
    }
  });

  it("verifyAuditChain detects tampered payload", () => {
    const { db, close } = createTmpStorage();
    try {
      appendAuditLog(db, makeEvent({ sql: "SELECT 1" }));
      appendAuditLog(db, makeEvent({ sql: "SELECT 2" }));
      appendAuditLog(db, makeEvent({ sql: "SELECT 3" }));

      // Tamper: modify the payload of the middle record without recomputing hash
      db.prepare(
        "UPDATE audit_log SET payload = REPLACE(payload, 'SELECT 2', 'SELECT HACKED') WHERE sql = 'SELECT 2'",
      ).run();

      const result = verifyAuditChain(db);
      expect(result.valid).toBe(false);
      expect(result.brokenAt).toBeTruthy();
    } finally {
      close();
    }
  });

  it("verifyAuditChain detects deleted middle record", () => {
    const { db, close } = createTmpStorage();
    try {
      appendAuditLog(db, makeEvent({ sql: "SELECT 1" }));
      const r2 = appendAuditLog(db, makeEvent({ sql: "SELECT 2" }));
      appendAuditLog(db, makeEvent({ sql: "SELECT 3" }));

      // Delete middle record → chain breaks
      db.prepare("DELETE FROM audit_log WHERE id = ?").run(r2.id);

      const result = verifyAuditChain(db);
      expect(result.valid).toBe(false);
      expect(result.brokenAt).toBeTruthy();
    } finally {
      close();
    }
  });

  it("verifyAuditChain detects forged middle insert", () => {
    const { db, close } = createTmpStorage();
    try {
      const r1 = appendAuditLog(db, makeEvent({ sql: "SELECT 1" }));
      appendAuditLog(db, makeEvent({ sql: "SELECT 2" }));

      // Forge: insert a fake record between r1 and r2
      // ULID sorts lexicographically, so we need an ID between r1.id and the next
      // We can directly INSERT to bypass the hash chain
      db.prepare(
        `
        INSERT INTO audit_log (
          id, created_at, tool_name, sql, connection_name, mcp_client_id,
          decision, trigger_rule, reason, exec_status, mysql_error_code,
          row_count, truncated, policy_duration_ms, exec_duration_ms,
          prev_hash, payload, hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        `${r1.id}FORGED`, // will sort after r1.id due to longer string
        new Date().toISOString(),
        "execute_sql",
        "SELECT FORGED",
        null,
        null,
        "allow",
        null,
        null,
        "success",
        null,
        0,
        0,
        null,
        null,
        "fake_prev_hash",
        "{}",
        "fake_hash",
      );

      const result = verifyAuditChain(db);
      expect(result.valid).toBe(false);
      expect(result.brokenAt).toBeTruthy();
    } finally {
      close();
    }
  });
});
