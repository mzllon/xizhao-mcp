import { Command } from "commander";

export const dashboardCommand = new Command("dashboard")
  .description("启动本地 Dashboard（Stage 09 实现）")
  .action(() => {
    console.log("xizhao dashboard 将在 Stage 09 实现");
    process.exit(1);
  });
