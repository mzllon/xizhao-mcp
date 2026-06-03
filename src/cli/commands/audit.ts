import chalk from "chalk";
import { Command } from "commander";
import { openStorage } from "../../core/storage.js";

export const auditCommand = new Command("audit")
  .description("查看审计日志")
  .option("--since <duration>", "时间范围（如 24h、7d）")
  .option("--deny-only", "只显示被拒绝的")
  .option("--sql <pattern>", "SQL 包含的关键词")
  .option("--connection <name>", "限定连接")
  .option("--limit <n>", "最多显示条数", "50")
  .action(
    (opts: {
      since?: string;
      denyOnly?: boolean;
      sql?: string;
      connection?: string;
      limit: string;
    }) => {
      const { raw, close } = openStorage();
      try {
        const conditions: string[] = [];
        const params: unknown[] = [];

        if (opts.since) {
          const ms = parseDuration(opts.since);
          if (ms !== null) {
            const since = new Date(Date.now() - ms).toISOString();
            conditions.push("created_at >= ?");
            params.push(since);
          }
        }

        if (opts.denyOnly) {
          conditions.push("decision = ?");
          params.push("deny");
        }

        if (opts.sql) {
          conditions.push("sql LIKE ?");
          params.push(`%${opts.sql}%`);
        }

        if (opts.connection) {
          conditions.push("connection_name = ?");
          params.push(opts.connection);
        }

        const where =
          conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const limit = Number.parseInt(opts.limit, 10) || 50;

        const rows = raw
          .prepare(
            `SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT ?`,
          )
          .all(...params, limit) as Record<string, unknown>[];

        if (rows.length === 0) {
          console.log(chalk.yellow("无审计记录"));
          return;
        }

        console.log(chalk.bold(`\n审计日志 (最近 ${rows.length} 条):\n`));
        for (const row of rows) {
          const time = (row.created_at as string).slice(11, 19);
          const decision = row.decision as string;
          const decisionColor =
            decision === "allow"
              ? chalk.green
              : decision === "deny"
                ? chalk.red
                : chalk.yellow;
          const sql = truncate(String(row.sql ?? ""), 60);

          console.log(
            `  ${chalk.dim(time)}  ${String(row.connection_name ?? "-").padEnd(16)}  ${String(row.tool_name ?? "-").padEnd(14)}  ${decisionColor(decision.padEnd(14))}  ${chalk.dim(sql)}`,
          );
        }
        console.log();
      } finally {
        close();
      }
    },
  );

function parseDuration(input: string): number | null {
  const match = input.match(/^(\d+)([hdm])$/);
  if (!match?.[1] || !match[2]) return null;
  const n = Number.parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case "h":
      return n * 3600_000;
    case "d":
      return n * 86400_000;
    case "m":
      return n * 60_000;
    default:
      return null;
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
