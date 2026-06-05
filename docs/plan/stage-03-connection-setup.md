# Stage 03：连接配置与 CLI 命令

> **输入：** Stage 02 存储 + 加密就绪
> **输出：** 连接 CRUD + `xm-sql-mcp setup` 7 步向导 + 全部 CLI 子命令
> **依赖：** Stage 02
> **关联 ADR：** [0006](../adr/0006-credential-encryption-and-master-key.md)、[0007](../adr/0007-onboarding-and-client-first.md)

## 目标

实现用户与 XM-SQL-MCP 的所有交互入口：CLI 命令 + setup 向导。本阶段完成后，用户可以通过 `xm-sql-mcp setup` 创建连接、通过 `xm-sql-mcp conn/policy/audit` 管理配置。

## 文件清单

- 创建：`src/core/connection.ts`
- 创建：`src/cli/index.ts`（commander 入口）
- 创建：`src/cli/commands/setup.ts`
- 创建：`src/cli/commands/conn.ts`
- 创建：`src/cli/commands/policy.ts`
- 创建：`src/cli/commands/audit.ts`
- 创建：`src/cli/commands/client.ts`（仅占位，stage 07 实现）
- 创建：`src/cli/commands/dashboard.ts`（仅占位，stage 09 实现）
- 创建：`src/cli/prompts/connection.ts`（inquirer prompts）
- 创建：`tests/unit/core/connection.test.ts`
- 创建：`tests/unit/cli/setup.test.ts`
- 创建：`tests/unit/cli/conn.test.ts`

## 详细步骤

### 3.1 连接 CRUD

- [ ] 实现 `src/core/connection.ts`：
  - `createConnection(input, masterKey)` → 加密 password、插入 `connections` 表、返回 Connection
  - `getConnection(name)` → 查询并解密 password
  - `listConnections()` → 返回所有连接（不含 password 明文）
  - `updateConnection(name, patch, masterKey)` → 部分更新
  - `deleteConnection(name)` → 删除
  - `testConnection(input)` → 用 mysql2 临时连接测试（不写入数据库）
  - `validateConnectionName(name)` → 小写字母/数字/`-`/`_`，长度 1-64，正则 `^[a-z0-9][a-z0-9-_]{0,63}$`

### 3.2 CLI 主入口

- [ ] 实现 `src/cli/index.ts`：

  ```ts
  import { Command } from "commander";
  import { VERSION } from "../shared/version.js";

  const program = new Command();
  program
    .name("xm-sql-mcp")
    .description("XM - AI ↔ MySQL 安全代理")
    .version(VERSION)
    .option("--verbose", "启用 debug 日志");

  program.addCommand(setupCommand);
  program.addCommand(clientCommand);
  program.addCommand(dashboardCommand);
  program.addCommand(connCommand);
  program.addCommand(policyCommand);
  program.addCommand(auditCommand);

  await program.parseAsync(process.argv);
  ```

- [ ] 实现 `--verbose` 全局 flag：设置 `XM_SQL_MCP_LOG_LEVEL=debug`
- [ ] 在 `process.argv` 解析前设置日志（让 verbose 在所有子命令中生效）

### 3.3 Setup 7 步向导（关键）

参考 [ADR-0007 line 36-44](../adr/0007-onboarding-and-client-first.md)。完整实现：

- [ ] **第 1 步**：收集 MySQL 连接信息
  - 连接别名（inquirer `input` + validate）
  - host（默认 `127.0.0.1`）
  - port（默认 `3306`）
  - username（默认 `lingshield`）
  - password（inquirer `password`）
  - default schema（可选）

- [ ] **第 2 步**：测试连接
  - 用 mysql2 临时连接，5 秒超时
  - 显示连接成功 / 失败
  - 失败时允许重试或退出
  - 成功时显示当前 MySQL 用户权限（`SHOW GRANTS`）

- [ ] **第 3 步**：提示不安全配置
  - 检测 GRANT 是否过宽（如 `GRANT ALL ON *.*`）
  - 如果过宽，**显示警告** + 建议的最小权限 SQL
  - **不自动执行 GRANT**——只展示，让用户自己执行
  - 显示示例：
    ```sql
    -- 建议执行(只读连接):
    CREATE USER 'lingshield_ro'@'%' IDENTIFIED BY '...';
    GRANT SELECT, INSERT, UPDATE, DELETE ON dev_orders.* TO 'lingshield_ro'@'%';
    ```

- [ ] **第 4 步**：策略预设选择
  - inquirer `list` 让用户从 3 个预设选：
    - `dev-default`（DML 自由、DDL 需审批、危险操作禁止）
    - `readonly-strict`（只读、强制 LIMIT 500）
    - `demo-loose`（全允许、仅 DROP DATABASE 需审批）
  - 选完后展示该预设的关键参数

- [ ] **第 5 步**：可选调整
  - 询问"是否需要调整预设参数？"
  - 是 → 进入简化版策略编辑器（开/关每个 statement type、调整 maxLimit）
  - 否 → 直接使用预设

- [ ] **第 6 步**：选择 MCP 客户端类型
  - inquirer `list`：
    - Claude Code
    - Codex (OpenAI Codex CLI)
    - Cursor
    - Continue / Cline / 其他
    - 跳过(我自己配)

- [ ] **第 7 步**：输出 MCP 客户端配置片段
  - 根据 第 6 步选择输出对应配置：
    - **Claude Code**：打印 `claude mcp add xm-sql-mcp -- xm-sql-mcp client`
    - **Codex**：自动探测版本（`codex --version`），输出对应格式（参考 ADR-0007 line 77-86 的探测策略）
    - **Cursor**：打印 Settings → MCP 添加说明
    - **其他**：打印通用 Stdio MCP 信息
  - 最后打印示例对话：
    ```
    ✅ 配置完成!现在你可以在 Claude Code 里说:
       "用 xm-sql-mcp 帮我查一下 orders 表有多少行"
    ```

### 3.4 CLI 子命令：conn

- [ ] 实现 `xm-sql-mcp conn <subcmd>`：
  - `xm-sql-mcp conn list` —— 表格形式列出所有连接（name, host, default_schema, policy_preset）
  - `xm-sql-mcp conn add` —— 走 setup 的简化版（不含 MCP 客户端配置）
  - `xm-sql-mcp conn edit <name>` —— 交互式编辑（inquirer）
  - `xm-sql-mcp conn delete <name>` —— 二次确认后删除
  - `xm-sql-mcp conn test <name>` —— 用存储的配置测试连接

### 3.5 CLI 子命令：policy

- [ ] 实现 `xm-sql-mcp policy <subcmd>`：
  - `xm-sql-mcp policy show <conn>` —— 显示该连接的策略（JSON pretty print）
  - `xm-sql-mcp policy set <conn> <key> <value>` —— 设置单个策略字段
    - 例：`xm-sql-mcp policy set dev-orders maxLimit 500`
    - 例：`xm-sql-mcp policy set dev-orders enforceLimit false`

### 3.6 CLI 子命令：audit

- [ ] 实现 `xm-sql-mcp audit [options]`：
  - `--since <duration>` —— 显示 N 时间内的（如 `--since 24h`、`--since 7d`）
  - `--deny-only` —— 只显示被拒绝的
  - `--sql <pattern>` —— SQL 包含 pattern 的（LIKE 语法）
  - `--connection <name>` —— 限定连接
  - `--limit <n>` —— 最多显示 N 条（默认 50）
  - 默认输出表格：timestamp | connection | tool | status | sql（截断 60 字符）

### 3.7 占位命令

- [ ] `src/cli/commands/client.ts`：仅打印"将在 stage 07 实现"+ `process.exit(1)`
- [ ] `src/cli/commands/dashboard.ts`：仅打印"将在 stage 09 实现"+ `process.exit(1)`

## 验收

```bash
pnpm test:unit tests/unit/core/connection.test.ts tests/unit/cli/
pnpm build
node dist/cli/index.js --help
node dist/cli/index.js conn --help
node dist/cli/index.js policy --help
node dist/cli/index.js audit --help
```

预期：

- 帮助输出包含 `setup` / `client` / `dashboard` / `conn` / `policy` / `audit` 6 个命令
- `setup` 在没装 MySQL 时能优雅退出（不报 stack trace）
- 测试覆盖率：`src/core/connection.ts` ≥ 80%，CLI 模块 ≥ 50%

## 关键技术点

### Setup 向导的状态机

- 7 步是线性的，但允许"上一步"（inquirer 支持）
- 失败时（如测试连接失败）允许重试当前步、跳过、退出
- 状态用 inquirer 自带的 prompt 流管理，不持久化

### Codex 版本探测策略

- 用 `child_process.spawnSync('codex', ['--version'])` 拿版本
- 用 `child_process.spawnSync('codex', ['--help'])` 拿帮助文本
- 根据 output 匹配已知版本模式：
  - 0.x → 输出格式 A
  - 1.x → 输出格式 B
- 都不匹配 → 输出所有已知格式的 fallback 清单

### 最小权限 SQL 生成

- 根据 第 1 步的 username + 第 4 步的策略预设推断最小权限：
  - `dev-default` → SELECT/INSERT/UPDATE/DELETE on schema.\*
  - `readonly-strict` → SELECT on schema.\*
  - `demo-loose` → SELECT/INSERT/UPDATE/DELETE/CREATE/DROP/ALTER/INDEX on schema.\*
- 只展示，不执行

## 实施风险

| 风险                              | 应对                                                 |
| --------------------------------- | ---------------------------------------------------- |
| Codex CLI 在测试环境不可用        | mock child_process，离线测试逻辑分支                 |
| Setup 向导步骤多，用户中途 Ctrl+C | 用 AbortController + SIGINT 处理，确保不留半成品配置 |
| MySQL `SHOW GRANTS` 输出格式不一  | 用 `mysql2` 解析后再展示，处理不同版本差异           |
| 连接名冲突（已存在时再 add）      | 提示用户是否覆盖或换名                               |
