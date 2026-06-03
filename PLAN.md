# Xizhao v1 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐阶段实现此计划。
> **每个阶段的详细步骤、文件清单、验收命令、风险点在 `docs/plan/stage-XX-*.md` 中。** 本文件仅作为索引 + 全局约束。

**目标：** 交付 Xizhao v1 Client 模式——本地 Stdio MCP 服务代理 AI 访问 MySQL，提供 AST 策略引擎、tamper-evident 审计日志、self-approval 工作流、本地 Dashboard。

**架构：** v1 以 `core/` 为真相来源，CLI、MCP tools、Web API 都只是传输层包装。MCP 通道走 Stdio，无 HTTP 认证；Dashboard 作为独立命令按需启动，使用本地 HTTP + Jupyter 风格 token 认证，与 `xizhao client` 进程并存。

**技术栈：** Node.js 20+ LTS、TypeScript strict、ESM、pnpm、commander、@inquirer/prompts、chalk、ora、`@modelcontextprotocol/sdk`、Zod、Hono、Next.js 14 App Router、shadcn/ui、Tailwind、`node-sql-parser`、mysql2、better-sqlite3、drizzle-orm、drizzle-kit、pino、pino-roll、Vitest、testcontainers、@fast-check/vitest。

---

## 0. 全局约束

### 0.1 v1 必须包含

- Client 模式 Stdio MCP 服务（5 个工具：`execute_sql` / `explain_sql` / `list_tables` / `describe_table` / `check_task_status`）
- CLI 命令：`xizhao setup` / `client` / `dashboard` / `conn <subcmd>` / `policy <subcmd>` / `audit [filters]`
- 连接配置加密存储，默认目录 `~/.xizhao/`
- AST-based 策略引擎（7 条规则）+ MySQL 最小权限提示
- append-only 审计日志 + hash 链
- Self-approval 工作流（Dashboard 上审批自己 AI 的请求）
- Dashboard：连接、策略、审计、审批、设置共 10 页

### 0.2 v1 不做

- 生产数据库访问
- Server 模式、API Key、多人 RBAC、多租户
- 表级 / 行级 / 列级权限
- Webhook、SaaS、遥测、自动更新、demo 数据、配置导入导出
- Claude Code / Codex 真实 E2E 自动化测试（仅手动验收）
- CSV 导出（PRD A-04 推迟）

### 0.3 跨阶段约束（所有阶段都必须遵守）

> 各项约束的完整定义见对应 ADR，此处仅列要点提醒。

**i18n 分层（完整定义见 [ADR-0012](./docs/adr/0012-misc-decisions.md)）：**
- MCP 错误信息 → **英文**（AI 训练语料英文为主，识别错误模式更准）
- CLI 交互提示 / Dashboard UI → **中文**
- 应用日志（pino）→ **英文键 + 英文 value**
- 代码注释 → 中英混用 | ADRs → **中文** | README → **双语**（英文主）

**代码规范：**
- ESLint：`@antfu/eslint-config` · Prettier：默认配置
- Husky + lint-staged：pre-commit 自动 fix（`lint` + `typecheck`）
- 提交前必跑：`pnpm lint && pnpm typecheck && pnpm test:unit`

**日志（完整定义见 [ADR-0012](./docs/adr/0012-misc-decisions.md)）：**
- **永不写 stdout**（MCP 协议占用），所有日志走 stderr + `~/.xizhao/logs/xizhao.log`
- pino redact 自动脱敏 password / apiKey / masterKey / Authorization / token
- 默认 level `info`，`--verbose` 或 `XIZHAO_LOG_LEVEL=debug` 启用 debug

**包管理：**
- pnpm 严格使用，禁止 `package-lock.json` / `yarn.lock` 进仓库
- 锁定 Node 20+/22+，CI 矩阵测两个版本

**测试覆盖率（完整定义见 [ADR-0011](./docs/adr/0011-testing-strategy.md)）：**
- `policy/**` / `crypto.ts` → **95%+** · `audit.ts` / `approval.ts` → **90%+**
- `connection.ts` → **80%+** · MCP tools → **70%+** · CLI / Web → **50%+**
- Vitest `coverageThreshold` 强制配置，低于阈值的 PR 不能合并

### 0.4 ADR 维护规则

- 实施过程中如发现 ADR 与现实冲突，**不要回头改旧 ADR**——写新 ADR 标注 `Supersedes ADR-NNNN`
- 仅当 ADR 存在明显笔误 / 链接错误时，可直接修改
- 阶段验收失败时，先判断是 PLAN 错还是 ADR 错，改对应那一份
- 所有 ADR 与 PLAN 的修订都用 git commit 留痕

### 0.5 阶段门禁（Stage Gate）

- **必须验收通过才能推进下一阶段**。不允许"先开始下一阶段，回头补测试"
- 阶段验收失败的应对路径：
  1. 修复 → 重测 → 通过 → 推进
  2. 发现根本性问题时，**写 ADR 记录决策变更**，再修 PLAN 或代码
  3. 不允许"跳过"或"暂缓"某个验收点
- 每完成一阶段，提交一次（`feat(stage-XX): description`）

---

## 1. 目标文件结构

```text
.
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
├── eslint.config.mjs
├── drizzle.config.ts
├── src/
│   ├── cli/
│   │   ├── index.ts
│   │   └── commands/
│   │       ├── setup.ts
│   │       ├── client.ts
│   │       ├── dashboard.ts
│   │       ├── conn.ts            # 新增: xizhao conn <list|add|edit|delete|test>
│   │       ├── policy.ts          # 新增: xizhao policy <show|set>
│   │       └── audit.ts           # 增强: --since --deny-only --sql
│   ├── core/
│   │   ├── app-paths.ts
│   │   ├── storage.ts             # SQLite + WAL + busy_timeout
│   │   ├── schema.ts              # drizzle schema 定义
│   │   ├── crypto.ts
│   │   ├── connection.ts
│   │   ├── policy/
│   │   │   ├── index.ts
│   │   │   ├── types.ts
│   │   │   ├── presets.ts
│   │   │   └── rules/
│   │   │       ├── approved-task-override.ts
│   │   │       ├── parse-error.ts
│   │   │       ├── multi-statement.ts
│   │   │       ├── enforce-statement-types.ts
│   │   │       ├── need-approval-statement-types.ts
│   │   │       ├── block-statement-types.ts
│   │   │       └── enforce-limit.ts
│   │   ├── audit.ts
│   │   ├── approval.ts
│   │   ├── mysql.ts
│   │   └── logger.ts
│   ├── mcp/
│   │   ├── server.ts
│   │   ├── context.ts             # AsyncLocalStorage for clientInfo/auditId
│   │   ├── response.ts
│   │   ├── middleware/
│   │   │   └── audit.ts           # withAudit wrapper
│   │   └── tools/
│   │       ├── execute-sql.ts
│   │       ├── explain-sql.ts
│   │       ├── list-tables.ts
│   │       ├── describe-table.ts
│   │       └── check-task-status.ts
│   ├── web/
│   │   ├── server.ts
│   │   ├── auth.ts
│   │   ├── api/
│   │   │   ├── connections.ts
│   │   │   ├── policy.ts
│   │   │   ├── audit.ts
│   │   │   ├── approvals.ts
│   │   │   └── settings.ts
│   │   └── frontend/
│   │       ├── app/
│   │       ├── components/
│   │       └── lib/
│   └── shared/
│       ├── ids.ts
│       ├── time.ts
│       ├── errors.ts
│       └── redact.ts
├── tests/
│   ├── fixtures/sql/
│   ├── unit/
│   ├── integration/
│   └── mcp/
└── .github/workflows/ci.yml
```

---

## 2. 阶段索引

| 阶段 | 文件 | 输入 | 输出 | 依赖 | 关联 ADR |
|------|------|------|------|------|---------|
| 1 工程骨架 | [stage-01](./docs/plan/stage-01-skeleton.md) | 空 repo | 可构建可测试骨架 | — | 0009, 0011, 0012 |
| 2 存储 + 加密 | [stage-02](./docs/plan/stage-02-storage-crypto.md) | 骨架 | SQLite + AES-GCM + master key | 1 | 0006, 0012 |
| 3 连接 + CLI | [stage-03](./docs/plan/stage-03-connection-setup.md) | 存储 | 连接 CRUD + setup 向导 + CLI 子命令 | 2 | 0006, 0007 |
| 4 策略引擎 | [stage-04](./docs/plan/stage-04-policy-engine.md) | 存储 | 7 条规则 + fixtures + property-based | 2 | 0002, 0008 |
| 5 审计 + 日志 | [stage-05](./docs/plan/stage-05-audit-log.md) | 存储 | hash 链 + pino 三层 + redact | 2, 4 | 0004, 0012 |
| 6 MySQL 执行 | [stage-06](./docs/plan/stage-06-mysql.md) | 连接 | pool + 5s 超时 + 截断 + EXPLAIN | 3 | 0010, 0012 |
| 7 MCP 服务 | [stage-07](./docs/plan/stage-07-mcp-server.md) | 全部 | 5 个工具 + 协议 + AsyncLocalStorage | 4, 5, 6 | 0010, 0003 |
| 8 审批工作流 | [stage-08](./docs/plan/stage-08-approval.md) | MCP | self-approval 闭环 + 修改 SQL 流转 | 4, 7 | 0008 |
| 9 Dashboard | [stage-09](./docs/plan/stage-09-dashboard.md) | 全部 | 10 页 + token 认证 + 与 client 并发 | 8 | 0009, 0006, 0012 |
| 10 发布 | [stage-10](./docs/plan/stage-10-release.md) | 全部 | README 双语 + npm + 二进制 + LICENSE | 9 | 0012 |

---

## 3. 推荐执行顺序

1. **阶段 1 → 3**：打通本地配置闭环（pnpm + SQLite + setup 向导 + 连接管理）
2. **阶段 4 → 8**：打通核心安全闭环（策略引擎 + 审计 + MySQL + MCP + 审批）
3. **阶段 9**：补 Dashboard，把 approval 工作流变成可用产品
4. **阶段 10**：发布、README、手动验收

核心模块优先 TDD：`policy` / `crypto` / `audit` / `approval` 必须先写失败测试，再写实现。

---

## 4. 风险清单

| 风险 | 影响 | 应对 |
|------|------|------|
| `node-sql-parser` 不支持某些 MySQL 8 语法 | 合法 SQL 被 fail-secure 拒绝 | 加入 `tests/fixtures/sql/`，由 AI 改写 SQL 或扩展兼容逻辑 |
| MCP 客户端展示 JSON 字符串不友好 | 终端用户看到裸 JSON | README 明示 AI 是主要消费者，错误 `message` 保持可读 |
| Dashboard 与 Client 进程同时访问 SQLite | 锁等待或写入冲突 | 单 `config.db` + WAL + `busy_timeout=5000` + 短事务；详细机制见 [stage-09](./docs/plan/stage-09-dashboard.md) |
| 审计写入失败导致工具失败 | 可用性下降 | 这是产品承诺，保留 fail-on-audit-failure |
| Docker 不可用导致集成测试跑不起来 | 本地反馈变慢 | 单元测试保持快速；集成测试放 CI 和本地 Docker 跑 |
| master.key 丢失 | 已存 MySQL 密码不可恢复 | 首次生成强提示；Dashboard 概览页显示主密钥健康卡片 |
| MySQL 5 秒查询超时不生效 | 慢查询拖垮 Client | 用 `MAX_EXECUTION_TIME` hint + `KILL QUERY` 双保险，见 [stage-06](./docs/plan/stage-06-mysql.md) |
| 配置热更新失败 | Dashboard 改了连接但 Client 不知道 | SIGHUP 信号 + SQLite update_hook 双通道，见 [stage-09](./docs/plan/stage-09-dashboard.md) |
