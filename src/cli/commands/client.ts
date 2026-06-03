import { Command } from "commander";

export const clientCommand = new Command("client")
  .description("启动 MCP Stdio 服务（Stage 07 实现）")
  .action(() => {
    console.log("xizhao client 将在 Stage 07 实现");
    process.exit(1);
  });
