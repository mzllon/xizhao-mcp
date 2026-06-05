/**
 * XM-SQL-MCP structured logger — pino + pino-roll + multistream.
 *
 * Three-layer log architecture (ADR-0012):
 *   1. Audit log    → SQLite `audit_log` table (separate module)
 *   2. App log      → file + stderr (this module)
 *   3. MCP protocol → stderr only (SDK own output)
 *
 * Key behaviours:
 *   - Dual output: rotating file (pino-roll) + stderr
 *   - Never writes to stdout (MCP protocol occupies it)
 *   - Built-in redact for sensitive fields
 *   - Level controlled by XM_SQL_MCP_LOG_LEVEL or --verbose
 *   - SQL full text logged by default; disable via XM_SQL_MCP_LOG_SQL=off
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import pino from "pino";
import { redactPaths } from "../shared/redact.js";
import { getPaths } from "./app-paths.js";

/**
 * Resolve pino-roll to an absolute path.
 *
 * pnpm strict isolation means pino's worker thread can't `require('pino-roll')`
 * from its own context. We resolve it here (from our module's context) and pass
 * the absolute path as the transport target.
 */
const pinoRollTarget = createRequire(import.meta.url).resolve("pino-roll");

/** Resolve effective log level from environment */
function resolveLogLevel(verbose?: boolean): pino.Level {
  const envLevel = process.env.XM_SQL_MCP_LOG_LEVEL;
  if (envLevel) {
    const normalized = envLevel.toLowerCase();
    const levels: pino.Level[] = [
      "trace",
      "debug",
      "info",
      "warn",
      "error",
      "fatal",
    ];
    if (levels.includes(normalized as pino.Level)) {
      return normalized as pino.Level;
    }
  }
  return verbose ? "debug" : "info";
}

/** Cache the logger instance so we don't create multiple file handles */
let _logger: pino.Logger | null = null;

/**
 * Create (or return cached) XM-SQL-MCP application logger.
 *
 * Uses pino.transport for worker-thread-based dual output:
 * 1. pino-roll: rotating file (daily + 10MB size limit)
 * 2. pino/file: stderr (fd 2)
 *
 * @param options.verbose - Enable debug level (CLI --verbose flag)
 * @param options.appDir  - Override config directory (for testing)
 */
export function createLogger(options?: {
  verbose?: boolean;
  appDir?: string;
}): pino.Logger {
  if (_logger) return _logger;

  const level = resolveLogLevel(options?.verbose);
  const paths = getPaths(options?.appDir);

  // Ensure log directory exists
  fs.mkdirSync(paths.logsDir, { recursive: true });

  // Base file path without extension — pino-roll appends number + extension
  const logBase = paths.logFile.replace(/\.log$/, "");

  const transport = pino.transport({
    targets: [
      {
        target: pinoRollTarget,
        level,
        options: {
          file: logBase,
          size: "10M",
          frequency: "daily",
          extension: ".log",
          mkdir: true,
        },
      },
      {
        target: "pino/file",
        level,
        options: { destination: 2 }, // stderr
      },
    ],
  });

  _logger = pino(
    {
      level,
      redact: {
        paths: redactPaths,
        censor: "[REDACTED]",
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    transport,
  );

  return _logger;
}

/**
 * Create a test logger that writes to a provided stream.
 * No file I/O, no worker threads — suitable for unit tests.
 */
export function createTestLogger(
  stream: pino.DestinationStream,
  level: pino.Level = "debug",
): pino.Logger {
  return pino(
    {
      level,
      redact: {
        paths: redactPaths,
        censor: "[REDACTED]",
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    stream,
  );
}

/** Reset the cached singleton logger. For testing only. */
export function resetLogger(): void {
  _logger = null;
}

/**
 * Check whether SQL should be logged at full text.
 * Default: on. Set XM_SQL_MCP_LOG_SQL=off to disable.
 */
export function shouldLogSql(): boolean {
  return process.env.XM_SQL_MCP_LOG_SQL !== "off";
}
