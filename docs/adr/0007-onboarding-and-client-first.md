# 0007: 首次启动流程、Client-first 优先级、CLI 与 Web 双轨管理

**Status**: Accepted
**Date**: 2026-06-02

## Context

最初 PRD 把 Client 模式与 Server 模式并列为 P0。讨论中确认：

- Server 模式（多用户 HTTP）是后续推向公司内部的形态，但**不是 v1 第一发布**。
- Client 模式（Stdio 单用户）是开发者本机的日常工具，自己用 Claude Code / Codex 写代码时高频使用。
- 学习路径上，Client 模式比 Server 模式简单（无 HTTP、无认证、无多用户），先把 Client 做扎实，核心代码（策略引擎、AST 解析、审计日志、加密存储）100% 复用到 Server。

## Decision

### v1 优先级：Client-first

- **v1 第一发布 = Client 模式**。Server 模式作为 v2 紧随其后，复用 v1 全部核心代码。
- 不再为 Server 模式做并行设计，所有 v1 设计决策以 Client 场景为准。Server 模式相关 ADR（0004 审计、0005 认证、0006 凭证加密）保持有效，作为 v2 实施时的设计输入。

### 安装与首次配置

**安装**：双路支持。

```bash
# 路径 A：零安装尝试
npx xm-sql-mcp setup

# 路径 B：常用者全局安装
npm install -g xm-sql-mcp
xm-sql-mcp setup
```

README 主推 A 路径（"30 秒上手"），文档中说明 B 路径。

**配置命令**：`xm-sql-mcp setup` 是单一入口的交互式向导，串行 7 步：

1. 询问 MySQL 连接信息（主机 / 端口 / 用户名 / 密码 / schema / 别名）
2. 测试连接（显示 MySQL 用户当前权限）
3. 提示不安全配置（如检测到 GRANT 权限过宽）
4. 询问是否启用强制 LIMIT + 上限
5. 询问是否启用只读模式
6. 选择 MCP 客户端类型 → 输出对应配置片段
7. 显示完成提示，给出示例对话

### 文件存储布局

```
~/.xm-sql-mcp/
├── master.key          # 主密钥 (mode 600)
├── config.db           # SQLite: connections, audit_log, policy 配置
└── logs/
    └── xm-sql-mcp.log
```

跨平台路径解析（Windows 上是 `%USERPROFILE%\.xm-sql-mcp\`）使用 [`env-paths`](https://www.npmjs.com/package/env-paths)。

### MCP 客户端配置片段（多版本兼容）

向导最后一步根据用户选择的客户端输出对应配置。

**Claude Code**（直接命令）：

```bash
claude mcp add xm-sql-mcp -- xm-sql-mcp client
```

**Cursor**（设置界面）：

```
Settings → MCP → Add new MCP Server
  Name:    xm-sql-mcp
  Type:    stdio
  Command: xm-sql-mcp client
```

**Codex（OpenAI Codex CLI）—— 多版本兼容**：

Codex CLI 迭代较快，配置格式可能跨版本变化。**策略**：

1. 向导不直接给固定片段，而是**先尝试自动探测**：运行 `codex --version` 与 `codex --help`，识别版本。
2. 根据探测结果输出对应格式（如 `~/.codex/config.toml` 的 `[mcp_servers.xm-sql-mcp]` 段，或新版可能的 JSON 格式）。
3. **若探测失败或不认识该版本**，输出**已知所有格式的 fallback 清单**，标注每个格式对应的版本范围，让用户自选。
4. 在文档站维护"Codex 版本 ↔ 配置格式"对照表，定期更新。

这种"探测 + 多格式 fallback"思路也适用于其他快速迭代的 MCP 客户端。

**通用 fallback**（其他 Stdio 客户端）：

输出通用协议信息，让用户根据自己客户端文档配置。

### 命令体系

```
xm-sql-mcp setup           # 首次配置（交互式向导）
xm-sql-mcp client          # MCP Stdio 服务（被 AI 客户端调用，非交互式）
xm-sql-mcp dashboard       # 启动本地 Web 控制台（按需）
xm-sql-mcp conn list|add|edit|delete|test
xm-sql-mcp policy show|set
xm-sql-mcp audit [--since] [--deny-only] [--sql <pattern>]
xm-sql-mcp --version
xm-sql-mcp --help
```

- `xm-sql-mcp client` 必须严格非交互（stdin/stdout 不能被 prompt 打扰）。
- 其他命令可交互。
- 工具链：[`commander`](https://www.npmjs.com/package/commander) + [`@inquirer/prompts`](https://www.npmjs.com/package/@inquirer/prompts) + [`ora`](https://www.npmjs.com/package/ora) + [`chalk`](https://www.npmjs.com/package/chalk)。

### 本地 Web 控制台：`xm-sql-mcp dashboard`

**v1 同时实现**，与 Server 模式（v2）共用前端代码。

- 按需启动：`xm-sql-mcp dashboard` → 默认 `localhost:9020` → 自动开浏览器。
- 可与 `xm-sql-mcp client` 同时运行，**两个命令独立但共享同一份 Self Storage**。self-approval 工作流依赖用户在 MCP 会话中打开 Dashboard 完成审批。
- 用途：审计日志可视化查看、连接配置 GUI、策略调整。比纯 CLI 体验好，作品集演示效果好（README 头图来源）。
- 前端栈：Next.js + shadcn/ui（与 PRD 一致）。
- 后端：复用 Client 模式的所有 SQLite 查询逻辑，包一层本地 HTTP（Hono / Fastify）。

## Consequences

**正面**：

- v1 范围显著缩小：无需 HTTP、认证、多用户、Session、API Key 管理。
- 学习曲线友好：先 Stdio + 单用户打通端到端，再叠加 Server 模式复杂度。
- 自用真实性最大化：作者本人用 Claude Code / Codex 时的真实工具。
- Web 控制台前端代码可在 v2 直接复用，无浪费。

**已接受的代价**：

- 同事要等 v2（Server 模式）才能共用 XM-SQL-MCP。v1 期间他们要么用竞品，要么暂时裸连。
- 推向公司内部的时间线拉长，但产品打磨更扎实。
- 多 MCP 客户端配置片段维护成本：需要持续更新对各客户端新版本的支持。

## Updates / 后续调整

- **被 ADR-0008 部分扩展**：本 ADR 写于"审批流整体砍掉 v1"的判断下。后续 ADR-0008 把 self-approval 工作流重新引入 v1。本 ADR 中"v1 范围显著缩小：无需 HTTP、认证、多用户、Session、API Key 管理"仍然有效（审批 ≠ 多用户，审批在 Client 模式下是 self-approve）。

**未来重新审视的触发条件**：

- Server 模式启动开发时（v2 起点） → 重新评估 Client 与 Server 是否合并为单二进制 + `--mode` 参数。
- 出现显著的多用户需求（公司内部其他人也想用） → 加速 v2 开发。
