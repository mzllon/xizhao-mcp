/**
 * Pino redact paths — patterns for sensitive fields to auto-redact in logs.
 *
 * These paths are passed directly to `pino({ redact })`.
 * Pino supports exact paths, wildcard prefixes (`*.`), and glob patterns (`*word*`).
 *
 * Reference: ADR-0004, ADR-0012
 */

export const redactPaths: string[] = [
  // Password variants
  "password",
  "passwordEnc",
  "password_enc",
  "*.password",
  "*.passwordEnc",
  "*.password_enc",
  "*.Password",
  "*Password*",
  "*password*",

  // API keys
  "apiKey",
  "*._apiKey",
  "*.ApiKey",
  "*.api_key",
  "*apiKey*",
  "*api_key*",

  // Master key
  "masterKey",
  "master_key",
  "*.masterKey",
  "*.master_key",

  // Authorization headers
  "req.headers.authorization",
  "req.headers.Authorization",

  // Tokens
  "token",
  "*._token",
  "*.Token",
  "*_token",
  "*Token*",
];
