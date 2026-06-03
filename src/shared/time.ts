/**
 * Time utilities for Xizhao.
 *
 * All timestamps use ISO 8601 format.
 * Wrap for easy mocking in tests.
 */

/** Current time as ISO 8601 string */
export const nowIso = (): string => new Date().toISOString();
