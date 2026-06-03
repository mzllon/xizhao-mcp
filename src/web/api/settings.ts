/**
 * Settings API routes.
 *
 * Endpoints:
 *   GET   /api/settings — Get current settings
 *   PATCH /api/settings — Update settings
 */
import { Hono } from "hono";

/** Default settings stored in ~/.xizhao/settings.json */
export interface DashboardSettings {
  defaultPolicyPreset: string;
  approvalTtlHours: number;
  auditRetentionDays: number;
}

const DEFAULT_SETTINGS: DashboardSettings = {
  defaultPolicyPreset: "dev-default",
  approvalTtlHours: 24,
  auditRetentionDays: 90,
};

export function createSettingsApi(): Hono {
  const router = new Hono();

  // In-memory settings for v1 (persisted to DB or file in future)
  let settings: DashboardSettings = { ...DEFAULT_SETTINGS };

  router.get("/", (c) => {
    return c.json(settings);
  });

  router.patch("/", async (c) => {
    const body = (await c.req.json()) as Partial<DashboardSettings>;
    settings = { ...settings, ...body };
    return c.json(settings);
  });

  return router;
}
