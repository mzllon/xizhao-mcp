import { confirm, input, password } from "@inquirer/prompts";
import chalk from "chalk";
import { Command } from "commander";
import {
  createConnection,
  deleteConnection,
  getConnection,
  listConnections,
  updateConnection,
  validateConnectionName,
} from "../../core/connection.js";
import { loadOrCreateMasterKey } from "../../core/crypto.js";
import { openStorage } from "../../core/storage.js";

export const connCommand = new Command("conn")
  .description("管理数据库连接")
  .addCommand(
    new Command("list").description("列出所有连接").action(() => {
      const { raw, close } = openStorage();
      try {
        const conns = listConnections(raw);
        if (conns.length === 0) {
          console.log(
            chalk.yellow("暂无连接，运行 xizhao setup 创建第一个连接"),
          );
          return;
        }
        console.log(chalk.bold("\n数据库连接:\n"));
        for (const c of conns) {
          const policyLabel = tryParsePolicyLabel(c.policy);
          console.log(
            `  ${chalk.cyan(c.name)}  ${c.username}@${c.host}:${c.port}  ${c.defaultSchema ? chalk.dim(`[${c.defaultSchema}]`) : ""}  ${chalk.dim(policyLabel)}`,
          );
        }
        console.log();
      } finally {
        close();
      }
    }),
  )
  .addCommand(
    new Command("add").description("添加连接").action(async () => {
      const { raw, paths, close } = openStorage();
      const masterKey = loadOrCreateMasterKey(paths.dir);
      try {
        const name = await input({
          message: "连接别名:",
          validate: (v) =>
            validateConnectionName(v) === true ||
            (validateConnectionName(v) as string),
        });
        const host = await input({ message: "主机:", default: "127.0.0.1" });
        const portStr = await input({ message: "端口:", default: "3306" });
        const username = await input({ message: "用户名:", default: "root" });
        const pwd = await password({ message: "密码:" });
        const defaultSchema = await input({ message: "默认数据库（可选）:" });

        createConnection(
          raw,
          {
            name,
            host,
            port: Number.parseInt(portStr, 10),
            username,
            password: pwd,
            defaultSchema: defaultSchema || undefined,
            policy: JSON.stringify({ preset: "dev-default" }),
          },
          masterKey,
        );

        console.log(chalk.green(`✅ 连接 "${name}" 已创建`));
      } finally {
        close();
      }
    }),
  )
  .addCommand(
    new Command("edit")
      .description("编辑连接")
      .argument("<name>", "连接别名")
      .action(async (name: string) => {
        const { raw, paths, close } = openStorage();
        const masterKey = loadOrCreateMasterKey(paths.dir);
        try {
          const host = await input({ message: "主机（留空不修改）:" });
          const portStr = await input({ message: "端口（留空不修改）:" });
          const username = await input({ message: "用户名（留空不修改）:" });
          const pwd = await password({ message: "密码（留空不修改）:" });

          const patch: Record<string, unknown> = {};
          if (host) patch.host = host;
          if (portStr) patch.port = Number.parseInt(portStr, 10);
          if (username) patch.username = username;
          if (pwd) patch.password = pwd;

          updateConnection(raw, name, patch, masterKey);
          console.log(chalk.green(`✅ 连接 "${name}" 已更新`));
        } finally {
          close();
        }
      }),
  )
  .addCommand(
    new Command("delete")
      .description("删除连接")
      .argument("<name>", "连接别名")
      .action(async (name: string) => {
        const shouldDelete = await confirm({
          message: `确认删除连接 "${name}"？`,
          default: false,
        });
        if (!shouldDelete) {
          console.log(chalk.yellow("已取消"));
          return;
        }
        const { raw, close } = openStorage();
        try {
          deleteConnection(raw, name);
          console.log(chalk.green(`✅ 连接 "${name}" 已删除`));
        } finally {
          close();
        }
      }),
  )
  .addCommand(
    new Command("test")
      .description("测试连接")
      .argument("<name>", "连接别名")
      .action(async (name: string) => {
        const { raw, paths, close } = openStorage();
        const masterKey = loadOrCreateMasterKey(paths.dir);
        try {
          const conn = getConnection(raw, name, masterKey);
          console.log(
            chalk.dim(`正在测试 "${name}" (${conn.host}:${conn.port})...`),
          );

          const mysql = await import("mysql2/promise");
          const opts: Record<string, unknown> = {
            host: conn.host,
            port: conn.port,
            user: conn.username,
            password: conn.password,
            connectTimeout: 5000,
          };
          if (conn.defaultSchema) opts.database = conn.defaultSchema;

          const client = await mysql.createConnection(opts);
          await client.ping();
          await client.end();
          console.log(chalk.green(`✅ 连接 "${name}" 正常`));
        } catch (err) {
          console.log(
            chalk.red(
              `❌ 连接失败: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        } finally {
          close();
        }
      }),
  );

function tryParsePolicyLabel(policyJson: string): string {
  try {
    const obj = JSON.parse(policyJson);
    if (obj.preset) return obj.preset;
    return "custom";
  } catch {
    return "unknown";
  }
}
