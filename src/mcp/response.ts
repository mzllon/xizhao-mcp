/**
 * MCP tool response formatting helpers.
 *
 * All responses (success and error) are self-contained JSON strings in
 * `content[0].text`, following ADR-0010:
 *   - Success: `{ data: ..., auditId }`
 *   - Error:   `{ error: { code, message, detail? }, auditId }`
 *
 * No use of `_meta` — clients may not reliably preserve it.
 *
 * Types include `[x: string]: unknown` index signature to satisfy
 * the SDK's CallToolResult (which extends Result with that signature).
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ErrorCode } from "../shared/errors.js";

/** Format a successful MCP tool response */
export function success(data: unknown, auditId: string): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ data, auditId }, null, 2),
      },
    ],
  };
}

/** Format an error MCP tool response */
export function error(
  code: ErrorCode,
  message: string,
  auditId: string,
  detail?: unknown,
): CallToolResult {
  const payload: {
    error: { code: ErrorCode; message: string; detail?: unknown };
    auditId: string;
  } = {
    error: { code, message },
    auditId,
  };
  if (detail !== undefined) {
    payload.error.detail = detail;
  }
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}
