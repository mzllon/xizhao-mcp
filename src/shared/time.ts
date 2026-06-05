/**
 * Time utilities for XM-SQL-MCP.
 *
 * All timestamps use ISO 8601 format.
 * Wrap for easy mocking in tests.
 */

/** Current time as ISO 8601 string */
export const nowIso = (): string => new Date().toISOString();
