import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      thresholds: {
        "src/core/policy/**": { lines: 95, functions: 95, branches: 90 },
        "src/core/crypto.ts": { lines: 95, functions: 95, branches: 90 },
        "src/core/audit.ts": { lines: 90, functions: 90, branches: 85 },
        "src/core/logger.ts": { lines: 80, functions: 80, branches: 75 },
        "src/core/approval.ts": { lines: 90, functions: 90, branches: 85 },
        "src/core/connection.ts": { lines: 80, functions: 80, branches: 75 },
        "src/mcp/tools/**": { lines: 70, functions: 70, branches: 65 },
        "src/cli/**": { lines: 50, functions: 50, branches: 45 },
        "src/web/**": { lines: 50, functions: 50, branches: 45 },
      },
    },
    typecheck: {
      enabled: true,
    },
  },
});
