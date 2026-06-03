import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getPaths } from "../../../src/core/app-paths.js";

describe("app-paths", () => {
  describe("getPaths", () => {
    it("uses provided appDir", () => {
      const testDir = path.join(os.tmpdir(), "xizhao-test-paths");
      const paths = getPaths(testDir);
      expect(paths.dir).toBe(path.resolve(testDir));
      expect(paths.configDb).toBe(
        path.resolve(path.join(testDir, "config.db")),
      );
      expect(paths.masterKey).toBe(
        path.resolve(path.join(testDir, "master.key")),
      );
      expect(paths.logsDir).toBe(path.resolve(path.join(testDir, "logs")));
      expect(paths.logFile).toBe(
        path.resolve(path.join(testDir, "logs", "xizhao.log")),
      );
      expect(paths.dashboardToken).toBe(
        path.resolve(path.join(testDir, "dashboard.token")),
      );
    });

    it("resolves relative paths to absolute", () => {
      const paths = getPaths("./relative-test");
      expect(path.isAbsolute(paths.dir)).toBe(true);
    });

    it("uses XIZHAO_HOME env when no appDir provided", () => {
      const origEnv = process.env.XIZHAO_HOME;
      try {
        const envPath = path.join(os.tmpdir(), "env-xizhao");
        process.env.XIZHAO_HOME = envPath;
        const paths = getPaths();
        expect(paths.dir).toBe(envPath);
      } finally {
        if (origEnv !== undefined) {
          process.env.XIZHAO_HOME = origEnv;
        } else {
          delete process.env.XIZHAO_HOME;
        }
      }
    });

    it("falls back to ~/.xizhao when no appDir and no env", () => {
      const origEnv = process.env.XIZHAO_HOME;
      try {
        delete process.env.XIZHAO_HOME;
        const paths = getPaths();
        expect(paths.dir).toMatch(/\.xizhao$/);
      } finally {
        if (origEnv !== undefined) {
          process.env.XIZHAO_HOME = origEnv;
        }
      }
    });
  });
});
