import chalk from "chalk";
import { Command } from "commander";
import { openStorage } from "../../core/storage.js";

export const policyCommand = new Command("policy")
  .description("查看或修改连接策略")
  .addCommand(
    new Command("show")
      .description("显示连接策略")
      .argument("<conn>", "连接别名")
      .action((conn: string) => {
        const { raw, close } = openStorage();
        try {
          const row = raw
            .prepare("SELECT policy FROM connections WHERE name = ?")
            .get(conn) as { policy: string } | undefined;
          if (!row) {
            console.log(chalk.red(`连接 "${conn}" 不存在`));
            return;
          }
          const policy = JSON.parse(row.policy);
          console.log(chalk.bold(`\n策略: ${conn}\n`));
          console.log(JSON.stringify(policy, null, 2));
          console.log();
        } finally {
          close();
        }
      }),
  )
  .addCommand(
    new Command("set")
      .description("设置策略字段")
      .argument("<conn>", "连接别名")
      .argument("<key>", "策略字段名")
      .argument("<value>", "新值")
      .action((conn: string, key: string, value: string) => {
        const { raw, close } = openStorage();
        try {
          const row = raw
            .prepare("SELECT policy FROM connections WHERE name = ?")
            .get(conn) as { policy: string } | undefined;
          if (!row) {
            console.log(chalk.red(`连接 "${conn}" 不存在`));
            return;
          }
          const policy = JSON.parse(row.policy);
          // Try to parse as number or boolean, fallback to string
          if (value === "true") policy[key] = true;
          else if (value === "false") policy[key] = false;
          else if (/^\d+$/.test(value))
            policy[key] = Number.parseInt(value, 10);
          else policy[key] = value;

          raw
            .prepare(
              "UPDATE connections SET policy = ?, updated_at = ? WHERE name = ?",
            )
            .run(JSON.stringify(policy), new Date().toISOString(), conn);

          console.log(
            chalk.green(
              `✅ 已更新 ${conn}.${key} = ${JSON.stringify(policy[key])}`,
            ),
          );
        } finally {
          close();
        }
      }),
  );
