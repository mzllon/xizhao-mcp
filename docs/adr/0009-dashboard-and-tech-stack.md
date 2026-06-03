# 0009: Web 控制台设计与 v1 技术栈确认

**Status**: Accepted
**Date**: 2026-06-02

## Context

Q12 讨论确认了 v1 dashboard 的认证模式、页面清单、代码组织、与技术栈选型。审批机制进入 v1 后，dashboard 不再是可选项，而是审批工作流的必经环节。

## Decision

### Dashboard 认证：Jupyter 风格 token

启动 `xizhao dashboard` 时：

1. 生成 32 字节随机 token
2. 写入 `~/.xizhao/dashboard.token`（mode 600）
3. 控制台打印 `http://localhost:9020/?token=<base64url>`
4. 第一次访问必须带 `?token=` 查询参数
5. 验证通过后设置 cookie（`HttpOnly; SameSite=Strict; Secure` 仅 HTTPS 时），后续免 token
6. 关闭 dashboard → token 文件删除、cookie 失效

**理由**：localhost 不是信任边界。同机器恶意进程、CSRF 攻击、其他用户（共享开发机场景）都可能绕过"localhost only"。Jupyter 风格 token 是行业内验证过的低成本方案。

### Dashboard 页面清单（10 个）

| 路由 | 功能 |
|------|------|
| `/` | 概览：连接数、近 24h 调用统计、待审批数 |
| `/connections` | 连接列表 |
| `/connections/new` | 新建连接 |
| `/connections/[name]` | 编辑/测试连接 |
| `/policy/[name]` | 该连接的策略调整 |
| `/audit` | 审计日志（分页 + 过滤） |
| `/audit/[id]` | 单条审计详情 |
| `/approvals` | 审批队列 |
| `/approvals/[taskId]` | 单任务审批 |
| `/settings` | 全局设置（默认策略预设、过期时间、清理审计） |

CSV 导出（PRD A-04）v1 不做，需要时用 CLI `xizhao audit --export csv`。

### 代码组织：四层架构

```
src/
├── core/                   # 业务逻辑,纯函数 + DB 访问,无传输层
│   ├── connection.ts
│   ├── policy.ts           # 策略引擎、规则实现
│   ├── audit.ts            # 审计写入与查询、hash 链
│   ├── approval.ts         # 审批任务管理
│   └── crypto.ts           # AES-256-GCM、token 生成
├── cli/                    # CLI 命令,调用 core
│   ├── commands/
│   └── prompts/            # inquirer 交互
├── mcp/                    # MCP Stdio 服务
│   ├── server.ts
│   └── tools/
├── web/                    # Dashboard HTTP 服务 + Next.js 前端
│   ├── server.ts           # Hono HTTP 服务
│   ├── api/                # REST 端点
│   └── frontend/           # Next.js app
└── shared/                 # 类型、工具、常量
```

**核心约束**：`core/` 是真相之源。CLI、MCP tools、Web API 都只是 `core/` 的不同传输层包装。

### 技术栈

| 层 | 选择 |
|----|------|
| 运行时 | Node.js 20+ LTS |
| 语言 | TypeScript 5+ strict mode |
| 模块系统 | ESM (`"type": "module"`) |
| 包管理 | pnpm |
| CLI 框架 | commander |
| CLI 交互 | @inquirer/prompts |
| HTTP 服务 | Hono |
| SQL 解析 | node-sql-parser |
| MySQL 驱动 | mysql2 |
| SQLite | better-sqlite3 |
| 加密 | node:crypto（内置） |
| 密码 hash | @node-rs/argon2 |
| ORM | drizzle-orm |
| 数据库迁移 | drizzle-kit |
| Web 前端 | Next.js 14+ (App Router) + shadcn/ui + Tailwind |
| 日志 | pino |
| 测试 | Vitest |

### 打包

- **Bun compile** 作为单二进制打包方案（`bun build --compile`）。Bun 仅作为打包器，运行时仍是 Node.js LTS。
- 备选 sea（Node 20+ 单二进制官方方案），若 Bun compile 出现兼容问题切换。

### 端口

- Dashboard 默认 `9020`，可通过 `--port` 参数或 `~/.xizhao/config.db` 中覆盖。
- 启动时检测端口占用，占用则递增尝试 `9021`、`9022`，最多 5 次。

## Consequences

**正面**：

- 技术栈现代化、TS 优先、ESM 原生。
- 四层架构使 CLI、MCP、Web 共享 `core/`，无业务逻辑重复。
- Jupyter 风格 token 提供合理 localhost 安全。
- shadcn/ui + Tailwind 给 dashboard 现代化外观，作品集演示效果好。

**已接受的代价**：

- ESM 在 Node 生态仍偶有兼容性坑（部分 CJS-only 包需 import 动态导入），需小心选型。
- Bun compile 作为打包器押注了非主流路径，若社区方向变化可能需迁移。
- Next.js 对纯 SPA dashboard 略重，但与 shadcn/ui 生态绑定深，权衡后选 Next.js。
- pnpm 要求团队成员都安装，但仅影响开发者（用户通过单二进制安装，不接触 pnpm）。

**未来重新审视的触发条件**：

- Bun runtime 生态成熟 → 评估切换运行时（不仅是打包器）
- 引入 SSR/服务端组件需求 → Next.js 价值凸显，否则可降级 Vite
- Server 模式上线 → Web 层增加认证、Session、API Key 管理（与 ADR-0005 对接）
