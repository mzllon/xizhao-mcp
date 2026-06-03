/**
 * AsyncLocalStorage-based request context for MCP tools.
 *
 * Carries client info, audit ID, and connection name across async boundaries
 * so middleware and handlers don't need to thread these values manually.
 *
 * Set by:
 *   - `server.oninitialize` → clientInfo
 *   - `withAudit` → auditId, connectionName
 *
 * Read by:
 *   - `withAudit` → mcpClientId for audit record
 *   - logger (future) → client info enrichment
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  clientInfo?: { name: string; version: string } | undefined;
  auditId?: string | undefined;
  connectionName?: string | undefined;
}

/**
 * RequestContextStorage — typed wrapper around AsyncLocalStorage<RequestContext>.
 *
 * Provides convenience accessors so callers don't need to destructure the store.
 */
class RequestContextStorage extends AsyncLocalStorage<RequestContext> {
  /** Get the MCP client info from the current request scope */
  getClientInfo(): { name: string; version: string } | undefined {
    return this.getStore()?.clientInfo;
  }

  /** Get the current audit ID from the request scope */
  getAuditId(): string | undefined {
    return this.getStore()?.auditId;
  }

  /** Get the current connection name from the request scope */
  getConnectionName(): string | undefined {
    return this.getStore()?.connectionName;
  }
}

/** Global request context store — singleton */
export const requestContext = new RequestContextStorage();
