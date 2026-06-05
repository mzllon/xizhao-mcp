import type { PolicyPresetName } from "../../shared/presets.js";
import { confirm, input, password, select } from "@inquirer/prompts";
import chalk from "chalk";
import { Command } from "commander";
import ora from "ora";
import {
  createConnection,
  validateConnectionName,
} from "../../core/connection.js";
import { loadOrCreateMasterKey } from "../../core/crypto.js";
import { openStorage } from "../../core/storage.js";
import { POLICY_PRESETS } from "../../shared/presets.js";

export const setupCommand = new Command("setup")
  .description("交互式初始化向导（7 步）")
  .action(async () => {
    console.log(chalk.bold("\n🦏 XM XM-SQL-MCP - 首次配置向导\n"));

    const { raw, close, paths } = openStorage();
    const masterKey = loadOrCreateMasterKey(paths.dir);

    try {
      // Step 1: MySQL connection info
      const connName = await input({
        message: "连接别名（小写字母、数字、连字符）:",
        validate: (name) =>
          validateConnectionName(name) === true ||
          (validateConnectionName(name) as string),
      });

      const host = await input({
        message: "MySQL 主机:",
        default: "127.0.0.1",
      });
      const portStr = await input({ message: "端口:", default: "3306" });
      const port = Number.parseInt(portStr, 10);
      const username = await input({ message: "用户名:", default: "root" });
      const pwd = await password({ message: "密码:" });
      const defaultSchema = await input({
        message: "默认数据库（可选，回车跳过）:",
      });

      const description = await input({
        message: '连接描述（可选，如"项目A开发库"）:',
      });

      // Step 2: Test connection
      const spinner = ora("测试连接...").start();
      try {
        const mysql = await import("mysql2/promise");
        const opts: Record<string, unknown> = {
          host,
          port,
          user: username,
          password: pwd,
          connectTimeout: 5000,
        };
        if (defaultSchema) opts.database = defaultSchema;

        const conn = await mysql.createConnection(opts);
        await conn.ping();
        spinner.succeed(chalk.green("连接成功！"));

        // Show grants
        const [grants] = (await conn.query("SHOW GRANTS")) as unknown as [
          string[],
          unknown,
        ];
        console.log(chalk.dim("\n当前用户权限:"));
        for (const g of grants) {
          const grantStr =
            typeof g === "string"
              ? g
              : Object.values(g as Record<string, string>)[0];
          console.log(chalk.dim(`  ${grantStr}`));
        }
        await conn.end();
      } catch (err) {
        spinner.fail(
          chalk.red(
            `连接失败: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        const shouldContinue = await confirm({
          message: "连接失败，是否仍然保存配置？",
          default: false,
        });
        if (!shouldContinue) {
          console.log(chalk.yellow("已取消"));
          return;
        }
      }

      // Step 4: Policy preset
      const presetName = (await select({
        message: "选择策略预设:",
        choices: Object.entries(POLICY_PRESETS).map(([key, preset]) => ({
          name: preset.label,
          value: key,
          description: preset.description,
        })),
      })) as PolicyPresetName;

      const preset = POLICY_PRESETS[presetName];
      console.log(chalk.dim(`\n已选: ${preset.label}`));

      // Step 5: Optional adjustment
      const wantAdjust = await confirm({
        message: "是否调整预设参数？",
        default: false,
      });
      let policy = JSON.stringify(preset);
      if (wantAdjust) {
        const maxLimitStr = await input({
          message: "LIMIT 上限:",
          default: String(preset.maxLimit),
        });
        const adjusted = {
          ...preset,
          maxLimit: Number.parseInt(maxLimitStr, 10),
        };
        policy = JSON.stringify(adjusted);
      }

      // Save connection
      createConnection(
        raw,
        {
          name: connName,
          host,
          port,
          username,
          password: pwd,
          defaultSchema: defaultSchema || undefined,
          description: description || undefined,
          policy,
        },
        masterKey,
      );

      // Step 6: MCP client type
      const clientType = (await select({
        message: "选择 MCP 客户端:",
        choices: [
          { name: "Claude Code", value: "claude-code" },
          { name: "Codex (OpenAI)", value: "codex" },
          { name: "Cursor", value: "cursor" },
          { name: "其他 / 跳过", value: "other" },
        ],
      })) as string;

      // Step 7: Output config
      console.log(chalk.bold("\n📋 MCP 客户端配置:\n"));
      switch (clientType) {
        case "claude-code":
          console.log(
            chalk.cyan("  claude mcp add xm-sql-mcp -- xm-sql-mcp client"),
          );
          break;
        case "codex":
          console.log(chalk.cyan("  # 在 codex 配置文件中添加:"));
          console.log(
            chalk.cyan(
              '  "mcpServers": { "xm-sql-mcp": { "command": "xm-sql-mcp", "args": ["client"] } }',
            ),
          );
          break;
        case "cursor":
          console.log(chalk.cyan("  Settings → MCP → Add Server"));
          console.log(chalk.cyan("  Command: xm-sql-mcp client"));
          break;
        default:
          console.log(chalk.cyan("  # Stdio MCP Server: xm-sql-mcp client"));
      }

      console.log(chalk.green(`\n✅ 配置完成！连接 "${connName}" 已保存。`));
      console.log(chalk.dim(`  现在你可以在 AI 客户端中说:`));
      console.log(
        chalk.dim(
          `  "用 xm-sql-mcp 帮我查一下 ${defaultSchema || "你的数据库"} 的表"\n`,
        ),
      );
    } finally {
      close();
    }
  });
