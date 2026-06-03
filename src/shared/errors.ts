/**
 * Xizhao standard error codes and error class.
 *
 * Error codes are used in MCP tool responses (JSON content),
 * matching the contract defined in ADR-0010.
 */

/** All MCP error codes — English for AI readability (ADR-0012) */
export type ErrorCode =
  | "NEED_APPROVAL"
  | "POLICY_VIOLATION"
  | "MYSQL_ERROR"
  | "TIMEOUT"
  | "MULTI_STATEMENT_NOT_SUPPORTED"
  | "SQL_PARSE_ERROR"
  | "CONNECTION_NOT_FOUND"
  | "INTERNAL_ERROR";

/** Structured error payload returned in MCP tool responses */
export interface XizhaoErrorDetail {
  code: ErrorCode;
  message: string;
  detail?: unknown;
  auditId?: string;
}

/**
 * XizhaoError — thrown internally, caught by withAudit / tool handler wrapper
 * and serialized into MCP `CallToolResult.isError: true` content.
 */
export class XizhaoError extends Error {
  readonly code: ErrorCode;
  readonly detail?: unknown;

  constructor(code: ErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = "XizhaoError";
    this.code = code;
    this.detail = detail;
  }

  /** Serialize for MCP error response content */
  toJSON(auditId?: string): { error: XizhaoErrorDetail } {
    const payload: XizhaoErrorDetail = {
      code: this.code,
      message: this.message,
    };
    if (this.detail !== undefined) payload.detail = this.detail;
    if (auditId !== undefined) payload.auditId = auditId;
    return { error: payload };
  }
}
