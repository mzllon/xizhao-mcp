# Xizhao v1 系统架构

> 本文档描述运行时架构——各进程、模块、存储在运行时如何协作。
> 概念定义见 [CONTEXT.md](../CONTEXT.md)，代码分层见 [ADR-0009](./adr/0009-dashboard-and-tech-stack.md)，MCP 工具契约见 [ADR-0010](./adr/0010-mcp-implementation.md)。

---

## 1. 运行时全景

v1 有两个独立进程，共享同一套文件系统（`~/.xizhao/`）：

```
┌─────────────────────────────────────────────────────────────────────┐
│  开发者本机                                                          │
│                                                                     │
│  ┌──────────────┐  stdin/stdout   ┌───────────────────────────┐     │
│  │  MCP 客户端   │ ◄─────────────► │  xizhao client (进程 A)   │     │
│  │  (Claude Code │   JSON-RPC      │                           │     │
│  │   / Codex /   │   over Stdio    │  ┌───────────────────┐   │     │
│  │   Cursor)     │                 │  │ MCP Server        │   │     │
│  └──────────────┘                 │  │  ├─ tools (×5)    │   │     │
│                                   │  │  ├─ withAudit     │   │     │
│                                   │  │  └─ AsyncLocal    │   │     │
│                                   │  └───────┬───────────┘   │     │
│                                   │          │               │     │
│                                   │  ┌───────▼───────────┐   │     │
│                                   │  │ core (业务逻辑)    │   │     │
│                                   │  │  ├─ policy engine  │   │     │
│                                   │  │  ├─ audit (hash链) │   │     │
│                                   │  │  ├─ approval       │   │     │
│                                   │  │  ├─ connection     │   │     │
│                                   │  │  ├─ crypto         │   │     │
│                                   │  │  └─ mysql (pool)   │───┼──┐  │
│                                   │  └───────┬───────────┘   │  │  │
│                                   │          │               │  │  │
│                                   │  ┌───────▼───────────┐   │  │  │
│                                   │  │ storage           │   │  │  │
│                                   │  │ (SQLite + WAL)    │   │  │  │
│                                   │  └───────────────────┘   │  │  │
│                                   └───────────────────────────┘  │  │
│                                                                  │  │
│  ┌──────────────┐  HTTP :9020   ┌───────────────────────────┐   │  │
│  │  浏览器       │ ◄────────────► │  xizhao dashboard (进程 B) │   │  │
│  │              │  token 认证     │                           │   │  │
│  └──────────────┘                │  ┌───────────────────┐   │   │  │
│                                  │  │ Hono REST API     │   │   │  │
│                                  │  └───────┬───────────┘   │   │  │
│                                  │  ┌───────▼───────────┐   │   │  │
│                                  │  │ core (同一个包)     │   │   │  │
│                                  │  └───────┬───────────┘   │   │  │
│                                  │  ┌───────▼───────────┐   │   │  │
│                                  │  │ storage (同一个 db) │   │   │  │
│                                  │  └───────────────────┘   │   │  │
│                                  │  ┌───────────────────┐   │   │  │
│                                  │  │ Next.js Frontend   │   │   │  │
│                                  │  └───────────────────┘   │   │  │
│                                  └───────────────────────────┘   │  │
│                                                                   │  │
│                                   ┌──────────────────────────┐    │  │
│                                   │  目标 MySQL (dev/test)    │◄───┘  │
│                                   │  由 mysql2 连接池访问      │       │
│                                   └──────────────────────────┘       │
└─────────────────────────────────────────────────────────────────────┘
```

### 关键约束

| 约束                                   | 说明                                                         |
| -------------------------------------- | ------------------------------------------------------------ |
| `core/` 是真相之源                     | CLI / MCP / Web API 都只调用 `core/`，不直接操作 DB 或 MySQL |
| 进程 A 的 stdin/stdout 被 MCP 协议独占 | 不允许任何 console.log / inquirer 交互                       |
| 两个进程共享同一个 `config.db`         | WAL 模式 + `busy_timeout=5000` + 短事务保证并发安全          |
| 进程 B 随用随启                        | `xizhao dashboard` 不常驻，审批/配置时才启动                 |

---

## 2. 请求流转（以 `execute_sql` 为例）

这是一个完整的 `execute_sql` 调用从入到出的路径：

```
MCP 客户端                    xizhao client 进程内部                    存储 / MySQL
─────────                    ──────────────────────                    ───────────

  JSON-RPC request
  { connection, sql }
        │
        ▼
  ┌─ MCP Server ──────────────────────────────────────────┐
  │                                                        │
  │  ① Zod 校验 args                                      │
  │     ├─ 失败 → 返回 SQL_PARSE_ERROR                     │
  │     └─ 通过 ↓                                         │
  │                                                        │
  │  ② withAudit 中间件（入口）                             │
  │     ├─ 生成 auditId (ULID)                              │
  │     ├─ AsyncLocalStorage.run({ auditId, ... })         │
  │     └─ 进入 handler ↓                                  │
  │                                                        │
  │  ③ getConnection(name)                      ◄── config.db (SQLite)
  │     ├─ 找不到 → 返回 CONNECTION_NOT_FOUND               │
  │     └─ 解密密码 (AES-256-GCM)                ◄── master.key
  │                                                        │
  │  ④ evaluate(sql, ctx) ─ 策略引擎 ──┐                   │
  │     │                               │                   │
  │     │  ④a Parser.astify(sql)        │                   │
  │     │      ├─ 失败 → Deny           │                   │
  │     │      └─ 成功 → AST            │                   │
  │     │                               │                   │
  │     │  ④b 规则链逐条评估：           │                   │
  │     │      1. approved-task-override ◄── approval_tasks (SQLite)
  │     │      2. parse-error (已在④a)  │                   │
  │     │      3. multi-statement       │                   │
  │     │      4. enforce-statement-types│                  │
  │     │      5. need-approval-types   │                   │
  │     │      6. block-statement-types │                   │
  │     │      7. enforce-limit         │                   │
  │     │                               │                   │
  │     └─ Deny ────────────────────────┘                   │
  │        ├─ 返回 POLICY_VIOLATION                        │
  │        └─ 审计记录 decision=deny ────────────► audit_log (SQLite)
  │                                                        │
  │     └─ NeedApproval                                    │
  │        ├─ 创建 approval_task (pending)       ──► approval_tasks
  │        ├─ 审计记录 decision=need_approval   ──► audit_log
  │        └─ 返回 NEED_APPROVAL { taskId, approvalUrl }   │
  │                                                        │
  │     └─ Allow                                           │
  │        ├─ 使用 modifiedSql ?? sql                       │
  │        │                                               │
  │  ⑤ executeSql(conn, sql)                   ──────────► MySQL (目标DB)
  │     ├─ 连接池 mysql2                                    │
  │     ├─ MAX_EXECUTION_TIME hint (5s 超时)                │
  │     ├─ 截断超大结果集                                   │
  │     └─ 返回 SqlResult                                  │
  │                                                        │
  │  ⑥ withAudit 中间件（出口）                             │
  │     ├─ 组装审计记录                                     │
  │     ├─ 计算 hash = sha256(prevHash + payload)          │
  │     ├─ 写入 audit_log                       ──► audit_log (SQLite)
  │     │   └─ 写失败 → 抛 INTERNAL_ERROR（fail-on-audit） │
  │     └─ 返回 success({ data, auditId })                  │
  │                                                        │
  └────────────────────────────────────────────────────────┘
        │
        ▼
  JSON-RPC response
  { data: { columns, rows, ... }, auditId }
```

### 审计覆盖

每个 `execute_sql` 调用产生 **1–2 条**审计记录：

| 场景               | 审计条数 | 记录内容                                |
| ------------------ | -------- | --------------------------------------- |
| Allow → 成功       | 1        | 策略 allow + MySQL 执行结果             |
| Allow → MySQL 错误 | 1        | 策略 allow + MySQL 错误                 |
| Deny               | 1        | 策略 deny + 触发规则                    |
| NeedApproval       | 1        | 策略 need_approval + taskId             |
| 审批通过后重试成功 | 1        | approved-task-override allow + 执行结果 |

审批决定本身（在 Dashboard 操作）还会额外产生独立的审计记录（审批创建 / 审批决定 / 任务 consumed 各一条），见 [ADR-0008](./adr/0008-policy-rules-and-approval-workflow.md#审计联动)。

---

## 3. 进程模型

### 3.1 `xizhao client`（常驻进程）

```
xizhao client
  ├─ MCP Server (Stdio transport)
  │   ├─ 监听 stdin (JSON-RPC)
  │   ├─ 写入 stdout (JSON-RPC)
  │   └─ 6 个 tool handler（含 list_connections）
  ├─ MySQL 连接池 (mysql2)
  │   ├─ 按 connection name 懒创建
  │   └─ 连接池大小：默认 5
  ├─ SQLite (better-sqlite3, WAL mode)
  │   ├─ config.db
  │   └─ busy_timeout=5000
  ├─ 日志 (pino)
  │   ├─ 输出到 stderr
  │   └─ 输出到 ~/.xizhao/logs/xizhao.log
  └─ 优雅关闭
      ├─ SIGINT / SIGTERM 触发
      ├─ 拒绝新请求
      ├─ 等待 in-flight 最长 5 秒
      ├─ 关闭 MySQL 连接池
      └─ 关闭 SQLite
```

### 3.2 `xizhao dashboard`（按需进程）

```
xizhao dashboard [--port 9020]
  ├─ Hono HTTP Server
  │   ├─ 静态 token 认证（Jupyter 风格）
  │   ├─ REST API (/api/connections, /api/policy, ...)
  │   └─ 代理 Next.js 前端
  ├─ Next.js App (SSR/CSR)
  │   └─ 10 页（概览/连接/策略/审计/审批/设置）
  ├─ SQLite (同一个 config.db, WAL mode)
  │   └─ 与 client 进程并发读写
  └─ 启动时
      ├─ 生成 32 字节 token
      ├─ 写入 ~/.xizhao/dashboard.token (mode 600)
      ├─ 打印 URL 到 stderr（不污染 stdout）
      └─ 端口冲突时递增尝试 (9020→9021→...最多 5 次)
```

### 3.3 并发共享模型

两个进程同时访问 `config.db` 时：

```
xizhao client                    xizhao dashboard
  │                                    │
  │  读 audit_log                      │  写 approval_task
  │  写 audit_log                      │  读/写 connections
  │  读 approval_tasks                 │  读/写 policy
  │  读 connections                    │
  │                                    │
  └──────────► config.db ◄────────────┘
              (SQLite WAL mode)
              busy_timeout=5000
```

- **写-写冲突**：WAL 模式下读者不阻塞，写者通过 `busy_timeout` 等待锁。短事务（<10ms）保证等待时间极短。
- **配置热更新**：Dashboard 改了连接配置后，Client 通过 SIGHUP 信号 + SQLite `update_hook` 感知变化，无需重启。
- **Dashboard 不操作 MySQL**：Dashboard 只管理配置和审批，不直接连接目标数据库。SQL 执行始终通过 Client 进程。

---

## 4. 存储模型

### 4.1 文件系统（`~/.xizhao/`）

```
~/.xizhao/
  ├── config.db            # SQLite 主库（WAL mode）
  ├── config.db-wal        # WAL 文件
  ├── config.db-shm        # 共享内存
  ├── master.key           # AES-256-GCM 主密钥（0600）
  ├── dashboard.token      # Dashboard token（运行时存在，关闭即删）
  └── logs/
      └── xizhao.log       # pino 日志文件（自动滚动）
```

### 4.2 SQLite `config.db` 表

| 表               | 用途                          | 写入者                                | 主要消费者                             |
| ---------------- | ----------------------------- | ------------------------------------- | -------------------------------------- |
| `connections`    | 连接配置（密码 AES-GCM 加密） | CLI setup / Dashboard                 | MCP tools（每次请求查连接）            |
| `audit_log`      | MCP 调用审计 + hash 链        | MCP client 进程                       | Dashboard 审计页、CLI audit 命令       |
| `approval_tasks` | 审批任务                      | MCP client（创建）+ Dashboard（审批） | MCP client（override 规则）+ Dashboard |

### 4.3 目标 MySQL

Xizhao **不在目标 MySQL 上创建任何表或对象**。它只是：

1. 用 `mysql2` 驱动建立连接池
2. 发送 SQL（由策略引擎放行的）
3. 返回结果（或 EXPLAIN 计划）

### 4.4 存储分层示意

```
┌─────────────────────────────────────────────────┐
│  Xizhao 进程                                     │
│                                                  │
│  传输层 (不存状态)                                 │
│  ├─ MCP Server (stdin/stdout, JSON-RPC)          │
│  ├─ Hono REST (HTTP :9020, token auth)           │
│  └─ CLI (commander + inquirer, 交互式)            │
│                                                  │
│  业务层 (core/, 无副作用)                          │
│  ├─ policy engine (AST → allow/deny/need_approval)│
│  ├─ audit (hash 链构建 + 校验)                     │
│  ├─ approval (任务状态机)                          │
│  ├─ crypto (AES-256-GCM 加解密)                   │
│  ├─ connection (CRUD + 加密存储)                   │
│  └─ mysql (连接池 + 超时 + 截断)                   │
│                                                  │
│  存储层                                           │
│  ├─ better-sqlite3 (config.db, WAL)               │
│  ├─ node:crypto (master.key)                      │
│  └─ mysql2 (目标数据库连接池)                       │
└─────────────────────────────────────────────────┘
        │                    │                │
        ▼                    ▼                ▼
  ~/.xizhao/            ~/.xizhao/      目标 MySQL
  config.db             master.key       (dev/test)
  (SQLite)              (文件)
```

---

## 5. 与同类项目的架构差异

| 维度   | 典型 MCP-MySQL 项目    | Xizhao                                 |
| ------ | ---------------------- | -------------------------------------- |
| 架构   | 单层：MCP tool → MySQL | 四层：传输层 → core → 存储层 → 目标 DB |
| 配置   | 环境变量明文密码       | 加密存储 + 主密钥文件                  |
| 策略   | 无，或仅字符串匹配     | AST 解析 + 7 条规则链                  |
| 审计   | 无，或仅应用日志       | hash 链 tamper-evident                 |
| 审批   | 无                     | self-approval 工作流                   |
| 管理   | 无 UI                  | 本地 Web Dashboard                     |
| 多连接 | 单连接（环境变量）     | 多连接别名，各有独立策略               |

Xizhao 的核心定位差异：**不是"给 AI 一个 MySQL 终端"，而是"在 AI 和 MySQL 之间插入一个可审计的安全代理"**。

---

## 6. 关键设计决策索引

| 决策                                          | ADR                                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 四层架构 + core 为真相之源                    | [ADR-0003](./adr/0003-authoritative-source-principle.md)、[ADR-0009](./adr/0009-dashboard-and-tech-stack.md)        |
| 策略引擎 AST 解析 + 规则链                    | [ADR-0002](./adr/0002-policy-engine-ast-and-grant.md)、[ADR-0008](./adr/0008-policy-rules-and-approval-workflow.md) |
| 审计 hash 链 + fail-on-audit                  | [ADR-0004](./adr/0004-audit-log-design.md)                                                                          |
| 凭证 AES-256-GCM + 主密钥文件                 | [ADR-0006](./adr/0006-credential-encryption-and-master-key.md)                                                      |
| MCP SDK + Zod + withAudit + AsyncLocalStorage | [ADR-0010](./adr/0010-mcp-implementation.md)                                                                        |
| 测试策略 + 覆盖率阈值                         | [ADR-0011](./adr/0011-testing-strategy.md)                                                                          |
| i18n 分层 + 日志规范                          | [ADR-0012](./adr/0012-misc-decisions.md)                                                                            |
