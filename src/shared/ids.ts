/**
 * ULID wrapper for XM-SQL-MCP.
 *
 * Wraps the `ulid` package so tests can mock ID generation.
 */
import { ulid as _ulid } from "ulid";

/** Generate a new ULID. Wrap for easy mocking in tests. */
export const generateUlid = (): string => _ulid();
