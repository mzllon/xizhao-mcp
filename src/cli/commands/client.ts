import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
/**
 * `xizhao client` — start the MCP Stdio server.
 *
 * Starts the Xizhao MCP server on stdio transport:
 *   - stdin  → JSON-RPC requests from MCP client
 *   - stdout → JSON-RPC responses (strictly pure, no other output)
 *   - stderr → pino structured logs
 *
 * Handles graceful shutdown:
 *   1. SIGINT/SIGTERM → set shuttingDown flag
 *   2. Wait for in-flight requests (up to 5s)
 *   3. Close MySQL pools
 *   4. Close SQLite
 *   5. Exit
 */
import { Command } from "commander";
import { expireOverdueTasks } from "../../core/approval.js";
import { loadOrCreateMasterKey } from "../../core/crypto.js";
import { createLogger } from "../../core/logger.js";
import { closeAllPools } from "../../core/mysql.js";
import { openStorage } from "../../core/storage.js";
import { createMcpServer } from "../../mcp/server.js";

/** Track in-flight tool calls for graceful shutdown */
const inflight = new Set<Promise<unknown>>();
let shuttingDown = false;

async function shutdown(
  signal: string,
  storage: ReturnType<typeof openStorage>,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.warn({ signal }, "Shutting down...");

  // Wait for in-flight requests (up to 5 seconds)
  await Promise.race([
    Promise.allSettled([...inflight]),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);

  // Close MySQL pools
  try {
    await closeAllPools();
  } catch (e: unknown) {
    logger.error({ err: e }, "Error closing MySQL pools");
  }

  // Close SQLite
  try {
    storage.close();
  } catch (e: unknown) {
    logger.error({ err: e }, "Error closing SQLite");
  }

  logger.info("Shutdown complete");
  process.exit(0);
}

export const clientCommand = new Command("client")
  .description("启动 MCP Stdio 服务")
  .action(async () => {
    // Silence console to keep stdout pure for MCP protocol
    console.log = () => {};
    console.info = () => {};
    console.warn = () => {};
    console.error = () => {};

    // Detect verbose from parent program options
    const verbose = clientCommand.parent?.opts()?.verbose === true;
    const logger = createLogger({ verbose });

    logger.info("Starting Xizhao MCP server...");

    // Initialize storage and crypto
    const storage = openStorage();
    const masterKey = loadOrCreateMasterKey();

    // Create MCP server
    const mcp = createMcpServer({
      getRawDb: () => storage.raw,
      getMasterKey: () => masterKey,
    });

    // Register signal handlers for graceful shutdown
    process.on("SIGINT", () => shutdown("SIGINT", storage, logger));
    process.on("SIGTERM", () => shutdown("SIGTERM", storage, logger));

    // Connect to stdio transport
    const transport = new StdioServerTransport();
    await mcp.connect(transport);

    logger.info("Xizhao MCP server connected on stdio");

    // Start approval task expiry job — runs every hour
    const expiryTimer = setInterval(
      () => {
        try {
          const count = expireOverdueTasks(storage.raw, new Date());
          if (count > 0) {
            logger.info({ count }, "Expired overdue approval tasks");
          }
        } catch (e: unknown) {
          logger.error({ err: e }, "Error running approval expiry job");
        }
      },
      60 * 60 * 1000,
    );

    // Prevent the timer from keeping the process alive
    if (expiryTimer.unref) {
      expiryTimer.unref();
    }
  });
