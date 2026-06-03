import type BetterSqlite3 from "better-sqlite3";
import crypto from "node:crypto";
import { generateUlid } from "../shared/ids.js";
import { nowIso } from "../shared/time.js";

/** Audit event to be recorded */
export interface AuditEvent {
  tool: string;
  sql?: string | undefined;
  connectionName?: string | undefined;
  mcpClientId?: string | undefined;
  /** Policy evaluation result */
  decision: "allow" | "deny" | "need_approval" | "parse_error";
  triggerRule?: string | undefined;
  reason?: string | undefined;
  policyDurationMs?: number | undefined;
  /** Execution result (only when decision=allow) */
  execStatus?: "success" | "error" | "timeout" | undefined;
  mysqlErrorCode?: string | undefined;
  rowCount?: number | undefined;
  truncated?: boolean | undefined;
  execDurationMs?: number | undefined;
}

/** Stored audit record */
export interface AuditRecord {
  id: string;
  createdAt: string;
  tool: string;
  sql: string | null;
  connectionName: string | null;
  mcpClientId: string | null;
  decision: string;
  triggerRule: string | null;
  reason: string | null;
  execStatus: string | null;
  mysqlErrorCode: string | null;
  rowCount: number | null;
  truncated: number;
  policyDurationMs: number | null;
  execDurationMs: number | null;
  prevHash: string;
  payload: string;
  hash: string;
}

/** Hash chain verification result */
export interface ChainVerification {
  valid: boolean;
  brokenAt?: string | undefined;
  totalRecords: number;
}

/**
 * Append an audit record to the audit log.
 *
 * - Synchronous write (better-sqlite3 sync API)
 * - Transactional with hash chain
 * - Throws on write failure (fail-on-audit-failure)
 *
 * Uses `ORDER BY rowid` (not ULID) to guarantee insertion order,
 * because ULIDs generated in the same millisecond may not sort
 * in insertion order due to their random suffix.
 */
export function appendAuditLog(
  db: BetterSqlite3.Database,
  event: AuditEvent,
): AuditRecord {
  const id = generateUlid();
  const createdAt = nowIso();

  try {
    // Transaction creation must be inside try — db.transaction() itself throws if db is closed
    const insert = db.transaction(() => {
      // rowid guarantees insertion-order retrieval regardless of ULID randomness
      const prevRow = db
        .prepare("SELECT hash FROM audit_log ORDER BY rowid DESC LIMIT 1")
        .get() as { hash: string } | undefined;
      const prevHash =
        prevRow?.hash ??
        "0000000000000000000000000000000000000000000000000000000000000000";

      const record = {
        id,
        createdAt,
        tool: event.tool,
        sql: event.sql ?? null,
        connectionName: event.connectionName ?? null,
        mcpClientId: event.mcpClientId ?? null,
        decision: event.decision,
        triggerRule: event.triggerRule ?? null,
        reason: event.reason ?? null,
        execStatus: event.execStatus ?? null,
        mysqlErrorCode: event.mysqlErrorCode ?? null,
        rowCount: event.rowCount ?? null,
        truncated: event.truncated ? 1 : 0,
        policyDurationMs: event.policyDurationMs ?? null,
        execDurationMs: event.execDurationMs ?? null,
        prevHash,
      };

      const payload = JSON.stringify(record);
      const hash = crypto.createHash("sha256").update(payload).digest("hex");

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
        id,
        createdAt,
        event.tool,
        record.sql,
        record.connectionName,
        record.mcpClientId,
        record.decision,
        record.triggerRule,
        record.reason,
        record.execStatus,
        record.mysqlErrorCode,
        record.rowCount,
        record.truncated,
        record.policyDurationMs,
        record.execDurationMs,
        prevHash,
        payload,
        hash,
      );

      return { ...record, payload, hash } as AuditRecord;
    });

    return insert();
  } catch (e: unknown) {
    throw new Error(
      `AUDIT_WRITE_FAILED: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Verify the integrity of the audit log hash chain.
 * Returns { valid: true } if intact, { valid: false, brokenAt } if tampered.
 *
 * Uses rowid ordering to traverse records in true insertion order.
 */
export function verifyAuditChain(
  db: BetterSqlite3.Database,
): ChainVerification {
  const rows = db
    .prepare(
      "SELECT id, prev_hash, payload, hash FROM audit_log ORDER BY rowid ASC",
    )
    .all() as Array<{
    id: string;
    prev_hash: string;
    payload: string;
    hash: string;
  }>;

  if (rows.length === 0) {
    return { valid: true, totalRecords: 0 };
  }

  let expectedPrevHash =
    "0000000000000000000000000000000000000000000000000000000000000000";

  for (const row of rows) {
    // Check prev_hash linkage
    if (row.prev_hash !== expectedPrevHash) {
      return { valid: false, brokenAt: row.id, totalRecords: rows.length };
    }

    // Recompute hash
    const computedHash = crypto
      .createHash("sha256")
      .update(row.payload)
      .digest("hex");
    if (row.hash !== computedHash) {
      return { valid: false, brokenAt: row.id, totalRecords: rows.length };
    }

    expectedPrevHash = row.hash;
  }

  return { valid: true, totalRecords: rows.length };
}
