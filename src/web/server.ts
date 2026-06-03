/**
 * Dashboard Hono server.
 *
 * Assembles all API routes, token auth, and serves the frontend SPA.
 */
import type BetterSqlite3 from "better-sqlite3";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createApprovalsApi } from "./api/approvals.js";
import { createAuditApi } from "./api/audit.js";
import { createConnectionsApi } from "./api/connections.js";
import { createDashboardApi } from "./api/dashboard.js";
import { createPolicyApi } from "./api/policy.js";
import { createSettingsApi } from "./api/settings.js";
import { createAuthMiddleware } from "./auth.js";
import { dashboardHtml } from "./frontend/index.js";

export interface DashboardDeps {
  getDb: () => BetterSqlite3.Database;
  getMasterKey: () => Buffer;
  tokenPath: string;
}

export function createDashboardApp(deps: DashboardDeps): Hono {
  const app = new Hono();

  // Health check (no auth needed)
  app.get("/api/ping", (c) => c.json({ ok: true }));

  // Auth middleware — applies to all /api/* except /api/ping
  const auth = createAuthMiddleware(deps.tokenPath);

  // API routes (protected)
  const apiRouter = new Hono();
  apiRouter.use("/*", auth);
  apiRouter.route("/approvals", createApprovalsApi(deps.getDb));
  apiRouter.route("/connections", createConnectionsApi(deps));
  apiRouter.route("/audit", createAuditApi(deps.getDb));
  apiRouter.route("/dashboard", createDashboardApi(deps.getDb));
  apiRouter.route("/policy", createPolicyApi(deps));
  apiRouter.route("/settings", createSettingsApi());
  app.route("/api", apiRouter);

  // Quick approve redirect: /approve/:taskId → /?approve=:taskId
  app.get("/approve/:taskId", (c) => {
    return c.redirect(`/?approve=${c.req.param("taskId")}`);
  });

  // Frontend SPA — serve for all non-API paths
  app.get("*", auth, (c) => {
    return c.html(dashboardHtml);
  });

  return app;
}

/**
 * Start the Dashboard HTTP server.
 * @returns The Node.js HTTP server instance
 */
export function startDashboardServer(deps: DashboardDeps, port: number) {
  const app = createDashboardApp(deps);
  return serve({ fetch: app.fetch, port });
}

/**
 * Find the next available port in a range.
 */
export async function findAvailablePort(
  start: number,
  end: number,
): Promise<number> {
  const net = await import("node:net");
  for (let port = start; port <= end; port++) {
    const available = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.on("error", () => resolve(false));
      server.listen(port, () => {
        server.close(() => resolve(true));
      });
    });
    if (available) return port;
  }
  throw new Error(`No available port in range ${start}-${end}`);
}
