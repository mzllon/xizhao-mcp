import crypto from "node:crypto";
import fs from "node:fs";
/**
 * \`xizhao dashboard\` — start the local web Dashboard.
 *
 * Flow:
 *   1. Generate token → write to ~/.xizhao/dashboard.token
 *   2. Find available port (9020–9025)
 *   3. Start Hono server
 *   4. Open browser with ?token=xxx
 *   5. On exit, clean up token file
 */
import { Command } from "commander";
import { getPaths } from "../../core/app-paths.js";
import { expireOverdueTasks } from "../../core/approval.js";
import { loadOrCreateMasterKey } from "../../core/crypto.js";
import { createLogger } from "../../core/logger.js";
import { openStorage } from "../../core/storage.js";
import { findAvailablePort, startDashboardServer } from "../../web/server.js";

let server: unknown;

export const dashboardCommand = new Command("dashboard")
  .description("启动本地 Dashboard Web 控制台")
  .option("-p, --port <port>", "指定端口号", Number.parseInt)
  .action(async (opts: { port?: number }) => {
    const logger = createLogger({
      verbose: dashboardCommand.parent?.opts()?.verbose === true,
    });
    const paths = getPaths();

    // Generate token
    const token = crypto.randomBytes(32).toString("base64url");
    fs.writeFileSync(paths.dashboardToken, token, { mode: 0o600 });
    logger.info("Dashboard token generated");

    // Open storage and load master key
    const storage = openStorage();
    const masterKey = loadOrCreateMasterKey();

    // Start approval expiry job
    const expiryTimer = setInterval(
      () => {
        try {
          const count = expireOverdueTasks(storage.raw, new Date());
          if (count > 0)
            logger.info({ count }, "Expired overdue approval tasks");
        } catch (e: unknown) {
          logger.error({ err: e }, "Error running approval expiry job");
        }
      },
      60 * 60 * 1000,
    );
    if (expiryTimer.unref) expiryTimer.unref();

    // Find port
    const port = opts.port ?? (await findAvailablePort(9020, 9025));
    logger.info({ port }, "Dashboard starting");

    // Start server
    server = startDashboardServer(
      {
        getDb: () => storage.raw,
        getMasterKey: () => masterKey,
        tokenPath: paths.dashboardToken,
      },
      port,
    );

    const url = `http://localhost:${port}/?token=${token}`;
    console.log(`🚀 犀照 Dashboard: ${url}`);

    // Open browser (best-effort)
    try {
      const { default: openBrowser } = await import("open");
      await openBrowser(url);
    } catch {
      // SSH session or headless — user can copy URL manually
      logger.info("Could not auto-open browser — copy the URL above");
    }

    // Graceful shutdown
    const cleanup = (signal: string) => {
      logger.info({ signal }, "Shutting down...");
      if (server && typeof server === "object" && "close" in server) {
        (server as { close: () => void }).close();
      }
      try {
        fs.unlinkSync(paths.dashboardToken);
      } catch {
        /* ignore */
      }
      try {
        storage.close();
      } catch {
        /* ignore */
      }
      clearInterval(expiryTimer);
      process.exit(0);
    };
    process.on("SIGINT", () => cleanup("SIGINT"));
    process.on("SIGTERM", () => cleanup("SIGTERM"));
    process.on("exit", () => {
      try {
        fs.unlinkSync(paths.dashboardToken);
      } catch {
        /* ignore */
      }
    });
  });
