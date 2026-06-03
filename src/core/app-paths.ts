import path from "node:path";

/** Default config directory: ~/.xizhao (consistent with ADR-0007) */
function getDefaultAppDir(): string {
  const home =
    process.env[process.platform === "win32" ? "USERPROFILE" : "HOME"];
  if (!home) throw new Error("Unable to determine home directory");
  return path.join(home, ".xizhao");
}

/** All paths used by Xizhao, resolved from a single root directory */
export function getPaths(appDir?: string) {
  const dir = path.resolve(
    appDir ?? process.env.XIZHAO_HOME ?? getDefaultAppDir(),
  );
  return {
    dir,
    configDb: path.join(dir, "config.db"),
    masterKey: path.join(dir, "master.key"),
    dashboardToken: path.join(dir, "dashboard.token"),
    logsDir: path.join(dir, "logs"),
    logFile: path.join(dir, "logs", "xizhao.log"),
  };
}
