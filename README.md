# 🔥 犀照 Xizhao

> **AI ↔ MySQL 安全代理** — 让 AI Agent 安全地访问 MySQL，带 AST 策略引擎、防篡改审计日志和自审批工作流。

[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## ✨ 核心特性

- **🔌 MCP Stdio Server** — 兼容 Claude Code、Cursor、Codex 等主流 AI 客户端
- **🛡️ AST 策略引擎** — 7 条规则链，基于 SQL AST 解析而非字符串匹配
- **📝 防篡改审计日志** — SHA-256 哈希链，任何记录篡改可被检测
- **🔐 自审批工作流** — DDL 等危险操作触发审批 → Dashboard 批准 → AI 自动执行
- **📊 Web Dashboard** — 本地控制台，管理连接、查看审计、审批任务
- **🗄️ 连接池管理** — mysql2 连接池 + 5 秒超时 + 结果截断

## 架构概览

```
┌─────────────┐    MCP/Stdio    ┌──────────────────┐    MySQL     ┌───────┐
│  AI Client   │ ◄────────────► │   xizhao client  │ ◄──────────► │ MySQL │
│ (Claude etc) │                │                  │              │       │
└─────────────┘                │  ┌────────────┐  │              └───────┘
                               │  │ Policy     │  │
┌─────────────┐    HTTP/WS     │  │ Engine     │  │
│  Dashboard   │ ◄────────────► │  ├────────────┤  │
│  (浏览器)    │                │  │ Audit Log  │  │
└─────────────┘                │  ├────────────┤  │
                               │  │ Approval   │  │
                               │  └────────────┘  │
                               └──────────────────┘
```

## 快速开始

### 安装

```bash
git clone https://github.com/mzllon/xizhao-mcp.git
cd xizhao-mcp
pnpm install
pnpm build
npm link    # 全局可用 xizhao 命令
```

### 初始化

```bash
xizhao setup
```

交互式向导引导你完成：MySQL 连接配置 → 测试连接 → 选择策略预设 → 保存。

### 启动使用

**终端 A** — 启动 MCP Server（AI 连这里）：

```bash
xizhao client
```

**终端 B** — 启动 Dashboard（审批管理）：

```bash
xizhao dashboard
# 🚀 犀照 Dashboard: http://localhost:9020/?token=xxx
```

### 配置 AI 客户端

**Claude Code:**

```bash
claude mcp add xizhao -- xizhao client
```

**Cursor / Codex / 其他 MCP 客户端:**

```json
{
  "mcpServers": {
    "xizhao": {
      "command": "xizhao",
      "args": ["client"]
    }
  }
}
```

## CLI 命令

```
xizhao setup                交互式初始化向导
xizhao client               启动 MCP Stdio 服务
xizhao dashboard [-p PORT]  启动 Dashboard Web 控制台
xizhao conn list            列出所有连接
xizhao conn add             添加连接
xizhao conn edit <name>     编辑连接
xizhao conn delete <name>   删除连接
xizhao conn test <name>     测试连接
xizhao policy <name>        查看连接策略
xizhao audit [--since 24h]  查看审计日志
```

## MCP 工具

AI 客户端可调用 6 个工具。**`list_connections` 必须最先调用**以发现可用连接：

| 工具                | 说明                                            |
| ------------------- | ----------------------------------------------- |
| `list_connections`  | **第一个调用** — 列出所有可用连接名、主机、策略 |
| `execute_sql`       | 执行 SQL（经策略引擎验证，DDL 需审批）          |
| `explain_sql`       | 获取 MySQL 执行计划                             |
| `list_tables`       | 列出数据库表                                    |
| `describe_table`    | 查看表 DDL                                      |
| `check_task_status` | 查询审批任务状态（NEED_APPROVAL 后轮询）        |

## 自审批工作流

当 AI 执行 DDL（如 `CREATE TABLE`）时：

```
1. AI 调用 list_connections → 发现可用连接名
2. AI 调用 execute_sql(connection, sql) → 策略引擎判定"需要审批"
3. xizhao 返回 NEED_APPROVAL + taskId + approvalUrl
4. 开发者在 Dashboard 点击"批准"（可选修改 SQL）
5. AI 调用 check_task_status 发现已批准
6. AI 重新调用 execute_sql → 自动 consume → 执行成功
```

## 策略引擎

7 条规则按序执行（首条命中即返回）：

| #   | 规则                          | 说明                            |
| --- | ----------------------------- | ------------------------------- |
| 1   | approved-task-override        | 已审批的 SQL 自动放行（防重放） |
| 2   | enforce-statement-types       | 只允许配置的语句类型            |
| 3   | need-approval-statement-types | DDL 等类型触发审批              |
| 4   | block-statement-types         | 永久阻止（DROP DATABASE 等）    |
| 5   | enforce-limit                 | SELECT 必须带 LIMIT             |

### 预设

| 预设              | 说明                                   |
| ----------------- | -------------------------------------- |
| `dev-default`     | 开发环境：DML 直接执行，DDL 需审批     |
| `readonly-strict` | 只读：仅允许 SELECT                    |
| `demo-loose`      | 宽松：几乎都允许，DROP DATABASE 需审批 |

## 审计日志

- 每条记录 SHA-256 哈希链链接
- 记录：工具名、SQL、连接、策略决定、执行状态、耗时
- 支持 CLI 和 Dashboard 查询
- `xizhao audit --deny-only` 查看被拒绝的操作

## 技术栈

| 层          | 技术                              |
| ----------- | --------------------------------- |
| MCP Server  | @modelcontextprotocol/sdk v1.29   |
| HTTP API    | Hono                              |
| 数据库      | SQLite (better-sqlite3, WAL mode) |
| MySQL 驱动  | mysql2 (连接池)                   |
| SQL 解析    | node-sql-parser v5                |
| Schema 验证 | Zod v4                            |
| 日志        | pino                              |
| CLI         | Commander.js                      |
| 构建        | tsup, TypeScript 6                |

## 项目结构

```
src/
├── cli/           CLI 命令 (setup, client, dashboard, conn, policy, audit)
├── core/          核心逻辑
│   ├── approval   审批任务状态机
│   ├── audit      防篡改审计日志
│   ├── connection 连接 CRUD + 加密
│   ├── crypto     AES-256-GCM 密钥管理
│   ├── logger     pino 结构化日志
│   ├── mysql      MySQL 执行层 (连接池/超时/截断)
│   ├── policy     AST 策略引擎 (7 rules)
│   └── storage    SQLite 存储层
├── mcp/           MCP Server
│   ├── server     McpServer + 6 tool 注册
│   ├── context    AsyncLocalStorage 请求上下文
│   ├── response   统一响应格式
│   ├── middleware  withAudit 中间件
│   └── tools      6 个工具处理器（含 list_connections）
├── shared/        共享工具 (errors, ids, time, redact)
└── web/           Dashboard
    ├── server     Hono 服务组装
    ├── auth       Token 认证
    ├── frontend   嵌入式 SPA
    └── api/       6 组 API 路由
```

## 开发

```bash
pnpm install          # 安装依赖
pnpm build            # 构建
pnpm test             # 运行测试
pnpm lint             # 代码检查
pnpm typecheck        # 类型检查
```

## License

MIT © [miles](https://github.com/mzllon)
