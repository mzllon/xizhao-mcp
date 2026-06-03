/**
 * ULID wrapper for Xizhao.
 *
 * Wraps the `ulid` package so tests can mock ID generation.
 */
import { ulid as _ulid } from "ulid";

/** Generate a new ULID. Wrap for easy mocking in tests. */
export const generateUlid = (): string => _ulid();
