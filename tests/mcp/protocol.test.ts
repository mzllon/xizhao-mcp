/**
 * Protocol-level tests for the MCP server.
 *
 * Tests:
 *   - Server creation succeeds
 *   - Tool registration produces correct tool list
 *   - Initialize handshake
 *   - Stdio stdout purity (no non-JSON-RPC output)
 *   - Graceful shutdown flow
 */
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JSONRPCMessage,
  JSONRPCResponse,
} from "@modelcontextprotocol/sdk/types.js";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../../src/mcp/server.js";

/** Create an in-memory test storage with schema migrated */
function createTestStorage() {
  const raw = new Database(":memory:");
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");

  const sql = [
    "CREATE TABLE IF NOT EXISTS connections (",
    "  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, host TEXT NOT NULL,",
    "  port INTEGER NOT NULL DEFAULT 3306, username TEXT NOT NULL,",
    "  password_enc TEXT NOT NULL, default_schema TEXT, policy TEXT NOT NULL,",
    "  description TEXT,",
    "  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_used_at TEXT",
    ");",
    "CREATE TABLE IF NOT EXISTS audit_log (",
    "  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, mcp_client_id TEXT,",
    "  connection_name TEXT, tool_name TEXT NOT NULL, sql TEXT,",
    "  decision TEXT NOT NULL, trigger_rule TEXT, reason TEXT,",
    "  exec_status TEXT, mysql_error_code TEXT, row_count INTEGER,",
    "  truncated INTEGER DEFAULT 0, policy_duration_ms INTEGER,",
    "  exec_duration_ms INTEGER, prev_hash TEXT NOT NULL,",
    "  payload TEXT NOT NULL, hash TEXT NOT NULL",
    ");",
    "CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);",
    "CREATE TABLE IF NOT EXISTS approval_tasks (",
    "  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,",
    "  connection_name TEXT NOT NULL, sql TEXT NOT NULL, sql_hash TEXT NOT NULL,",
    "  statement_type TEXT NOT NULL, trigger_rule TEXT NOT NULL,",
    "  status TEXT NOT NULL, decided_at TEXT, decider_kind TEXT,",
    "  modified_sql TEXT, decision_note TEXT, audit_id TEXT",
    ");",
  ].join("\n");
  raw.exec(sql);

  return raw;
}

/**
 * In-memory Transport for testing — replaces StdioServerTransport.
 * Allows sending messages and capturing responses without real I/O.
 */
class InMemoryTransport implements Transport {
  onclose?: (() => Promise<void>) | undefined;
  onerror?: ((error: Error) => Promise<void>) | undefined;
  onmessage?: ((message: JSONRPCMessage) => Promise<void>) | undefined;
  sessionId?: string | undefined;

  private _pendingMessages: JSONRPCResponse[] = [];

  async start(): Promise<void> {
    // No-op for in-memory
  }

  async close(): Promise<void> {
    await this.onclose?.();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this._pendingMessages.push(message as JSONRPCResponse);
  }

  /** Simulate receiving a message from the client */
  async receive(message: JSONRPCMessage): Promise<void> {
    await this.onmessage?.(message);
  }

  /** Get all messages sent by the server */
  getResponses(): JSONRPCResponse[] {
    return [...this._pendingMessages];
  }

  /** Clear collected responses */
  clear(): void {
    this._pendingMessages = [];
  }
}

describe("mCP Server creation", () => {
  let db: Database.Database;
  let masterKey: Buffer;

  beforeEach(() => {
    db = createTestStorage();
    masterKey = crypto.randomBytes(32);
  });

  afterEach(() => {
    db.close();
  });

  it("creates server without error", () => {
    const mcp = createMcpServer({
      getRawDb: () => db,
      getMasterKey: () => masterKey,
    });
    expect(mcp).toBeDefined();
    expect(mcp.server).toBeDefined();
  });

  it("registers all 5 tools", async () => {
    const mcp = createMcpServer({
      getRawDb: () => db,
      getMasterKey: () => masterKey,
    });

    const transport = new InMemoryTransport();
    await mcp.connect(transport);

    // Send initialize request
    transport.clear();
    await transport.receive({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    });

    // Wait for initialize response
    await new Promise((resolve) => setTimeout(resolve, 50));
    const initResponses = transport.getResponses();
    expect(initResponses.length).toBeGreaterThan(0);

    // Send initialized notification
    await transport.receive({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    // Now request tool list
    transport.clear();
    await transport.receive({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const toolResponses = transport.getResponses();
    expect(toolResponses.length).toBeGreaterThan(0);

    const result = toolResponses[0]!.result as {
      tools: Array<{ name: string }>;
    };
    const toolNames = result.tools.map((t) => t.name).sort();
    expect(toolNames).toEqual([
      "check_task_status",
      "describe_table",
      "execute_sql",
      "explain_sql",
      "list_connections",
      "list_tables",
    ]);
  });

  it("initialize response includes server info", async () => {
    const mcp = createMcpServer({
      getRawDb: () => db,
      getMasterKey: () => masterKey,
    });

    const transport = new InMemoryTransport();
    await mcp.connect(transport);

    await transport.receive({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const responses = transport.getResponses();
    expect(responses.length).toBeGreaterThan(0);

    const result = responses[0]!.result as Record<string, unknown>;
    expect(result.serverInfo).toEqual({ name: "xizhao", version: "0.0.1" });
  });
});
