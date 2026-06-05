#!/usr/bin/env node
import { Command } from "commander";
import { auditCommand } from "./commands/audit.js";
import { clientCommand } from "./commands/client.js";
import { connCommand } from "./commands/conn.js";
import { dashboardCommand } from "./commands/dashboard.js";
import { policyCommand } from "./commands/policy.js";
import { setupCommand } from "./commands/setup.js";

const program = new Command();
program
  .name("xm-sql-mcp")
  .description("XM - AI ↔ MySQL 安全代理")
  .version("0.0.1")
  .option("--verbose", "启用 debug 日志");

program.addCommand(setupCommand);
program.addCommand(clientCommand);
program.addCommand(dashboardCommand);
program.addCommand(connCommand);
program.addCommand(policyCommand);
program.addCommand(auditCommand);

program.parseAsync(process.argv);
