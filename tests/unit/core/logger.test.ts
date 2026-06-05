import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLogger,
  createTestLogger,
  resetLogger,
  shouldLogSql,
} from "../../../src/core/logger.js";

/**
 * In-memory stream that captures pino log output as string lines.
 * Used for testing logger behaviour without file I/O.
 */
class CaptureStream {
  readonly lines: string[] = [];

  write(msg: string): void {
    this.lines.push(msg);
  }
}

const cleanupQueue: string[] = [];

afterEach(() => {
  resetLogger();
  delete process.env.XM_SQL_MCP_LOG_LEVEL;
  delete process.env.XM_SQL_MCP_LOG_SQL;
  for (const dir of cleanupQueue) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Non-critical on Windows
    }
  }
  cleanupQueue.length = 0;
});

function createTmpDir(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xm-sql-mcp-log-"));
  cleanupQueue.push(tmpDir);
  return tmpDir;
}

describe("createTestLogger", () => {
  it("outputs valid JSON lines", () => {
    const stream = new CaptureStream();
    const logger = createTestLogger(stream);

    logger.info("hello");

    expect(stream.lines.length).toBe(1);
    const parsed = JSON.parse(stream.lines[0]);
    expect(parsed.msg).toBe("hello");
    expect(parsed.level).toBe(30); // info = 30
  });

  it("respects log level", () => {
    const stream = new CaptureStream();
    const logger = createTestLogger(stream, "warn");

    logger.info("should be suppressed");
    logger.warn("should appear");

    expect(stream.lines.length).toBe(1);
    const parsed = JSON.parse(stream.lines[0]);
    expect(parsed.msg).toBe("should appear");
  });

  it("redacts sensitive fields", () => {
    const stream = new CaptureStream();
    const logger = createTestLogger(stream);

    logger.info({ password: "secret123", username: "admin" }, "login attempt");

    expect(stream.lines.length).toBe(1);
    const parsed = JSON.parse(stream.lines[0]);
    expect(parsed.password).toBe("[REDACTED]");
    expect(parsed.username).toBe("admin");
  });

  it("redacts nested password fields", () => {
    const stream = new CaptureStream();
    const logger = createTestLogger(stream);

    logger.info({ conn: { password: "hidden", host: "localhost" } }, "test");

    const parsed = JSON.parse(stream.lines[0]);
    expect(parsed.conn.password).toBe("[REDACTED]");
    expect(parsed.conn.host).toBe("localhost");
  });

  it("redacts apiKey fields", () => {
    const stream = new CaptureStream();
    const logger = createTestLogger(stream);

    logger.info({ apiKey: "sk-12345", name: "test" }, "api call");

    const parsed = JSON.parse(stream.lines[0]);
    expect(parsed.apiKey).toBe("[REDACTED]");
    expect(parsed.name).toBe("test");
  });

  it("redacts authorization header", () => {
    const stream = new CaptureStream();
    const logger = createTestLogger(stream);

    logger.info(
      {
        req: {
          headers: {
            authorization: "Bearer xyz",
            "content-type": "application/json",
          },
        },
      },
      "request",
    );

    const parsed = JSON.parse(stream.lines[0]);
    expect(parsed.req.headers.authorization).toBe("[REDACTED]");
    expect(parsed.req.headers["content-type"]).toBe("application/json");
  });

  it("uses ISO 8601 timestamp", () => {
    const stream = new CaptureStream();
    const logger = createTestLogger(stream);

    logger.info("test");

    const parsed = JSON.parse(stream.lines[0]);
    expect(parsed.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("includes pid in log output", () => {
    const stream = new CaptureStream();
    const logger = createTestLogger(stream);

    logger.info("test");

    const parsed = JSON.parse(stream.lines[0]);
    expect(parsed.pid).toBe(process.pid);
  });

  it("does not write to stdout", () => {
    const { write } = process.stdout;
    const chunks: string[] = [];
    process.stdout.write = (chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      const stream = new CaptureStream();
      const logger = createTestLogger(stream);

      logger.info("test");

      expect(stream.lines.length).toBe(1);
      expect(chunks.length).toBe(0);
    } finally {
      process.stdout.write = write;
    }
  });

  it("handles multiple log levels correctly", () => {
    const stream = new CaptureStream();
    const logger = createTestLogger(stream, "trace");

    logger.trace("trace msg");
    logger.debug("debug msg");
    logger.info("info msg");
    logger.warn("warn msg");
    logger.error("error msg");

    expect(stream.lines.length).toBe(5);
  });
});

describe("createLogger (production path)", () => {
  it("returns a cached singleton", () => {
    const tmpDir = createTmpDir();
    const logger1 = createLogger({ appDir: tmpDir });
    const logger2 = createLogger({ appDir: tmpDir });
    expect(logger1).toBe(logger2);
  });

  it("defaults to info level", () => {
    const tmpDir = createTmpDir();
    const logger = createLogger({ appDir: tmpDir });
    expect(logger.level).toBe("info");
  });

  it("resolves verbose flag to debug level", () => {
    const tmpDir = createTmpDir();
    const logger = createLogger({ appDir: tmpDir, verbose: true });
    expect(logger.level).toBe("debug");
  });

  it("resolves XM_SQL_MCP_LOG_LEVEL env var", () => {
    process.env.XM_SQL_MCP_LOG_LEVEL = "trace";
    const tmpDir = createTmpDir();
    const logger = createLogger({ appDir: tmpDir });
    expect(logger.level).toBe("trace");
  });

  it("ignores invalid XM_SQL_MCP_LOG_LEVEL and falls back to info", () => {
    process.env.XM_SQL_MCP_LOG_LEVEL = "invalid";
    const tmpDir = createTmpDir();
    const logger = createLogger({ appDir: tmpDir });
    expect(logger.level).toBe("info");
  });

  it("creates the logs directory", () => {
    const tmpDir = createTmpDir();
    createLogger({ appDir: tmpDir });
    expect(fs.existsSync(path.join(tmpDir, "logs"))).toBe(true);
  });

  it("xIZHAO_LOG_LEVEL takes precedence over verbose", () => {
    process.env.XM_SQL_MCP_LOG_LEVEL = "error";
    const tmpDir = createTmpDir();
    const logger = createLogger({ appDir: tmpDir, verbose: true });
    // env var wins
    expect(logger.level).toBe("error");
  });

  it("writes log to file via transport", async () => {
    const tmpDir = createTmpDir();
    const logger = createLogger({ appDir: tmpDir });

    logger.info({ testMsg: "hello-from-transport" }, "transport test");

    // Wait for worker thread to flush (pino-roll writes asynchronously)
    // Retry for up to 3 seconds to handle worker thread startup latency
    const logsDir = path.join(tmpDir, "logs");
    let files: string[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      files = fs.existsSync(logsDir)
        ? fs.readdirSync(logsDir).filter((f) => f.endsWith(".log"))
        : [];
      if (files.length > 0) break;
    }

    expect(fs.existsSync(logsDir)).toBe(true);
    expect(files.length).toBeGreaterThanOrEqual(1);

    const content = fs.readFileSync(path.join(logsDir, files[0]!), "utf-8");
    expect(content).toContain("transport test");
    expect(content).toContain("hello-from-transport");
  });
});

describe("shouldLogSql", () => {
  it("returns true by default", () => {
    delete process.env.XM_SQL_MCP_LOG_SQL;
    expect(shouldLogSql()).toBe(true);
  });

  it("returns false when XM_SQL_MCP_LOG_SQL=off", () => {
    process.env.XM_SQL_MCP_LOG_SQL = "off";
    expect(shouldLogSql()).toBe(false);
  });

  it("returns true for any other value", () => {
    process.env.XM_SQL_MCP_LOG_SQL = "on";
    expect(shouldLogSql()).toBe(true);
  });
});
