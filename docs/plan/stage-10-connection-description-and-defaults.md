# Stage 10：连接描述与项目级默认值

> **输入：** Stage 07 MCP 服务（6 个工具已就位）
> **输出：** 连接 description 字段 + CLI 参数 `--default-connection` / `--default-schema` + `list_connections` 增强 + Dashboard 适配
> **依赖：** Stage 07
> **关联 ADR：** [0014](../adr/0014-connection-description-and-project-defaults.md)

## 目标

让 AI 不再猜测连接。两层机制：① 连接描述帮助 AI 自主判断；② CLI 参数为项目级 MCP 配置提供硬保证。

## 文件清单

- 修改：`src/core/storage.ts`（迁移加 description 列）
- 修改：`src/core/connection.ts`（类型 + CRUD 加 description）
- 修改：`src/cli/commands/client.ts`（`--default-connection` / `--default-schema` 参数）
- 修改：`src/cli/commands/setup.ts`（description 交互输入）
- 修改：`src/cli/commands/conn.ts`（add / edit / list 支持 description）
- 修改：`src/mcp/server.ts`（接受默认值参数，动态 description）
- 修改：`src/mcp/tools/list-connections.ts`（返回 description + 默认值）
- 修改：`src/web/api/connections.ts`（API 支持 description）
- 修改：`src/web/frontend/index.ts`（Dashboard 展示 + 编辑 description）
- 修改：`tests/unit/core/connection.test.ts`（description 相关测试）
- 创建：`tests/unit/core/storage-migration.test.ts`（迁移测试）
- 修改：`docs/adr/0012-misc-decisions.md`（修 License 为 MIT）
- 修改：`docs/ARCHITECTURE.md`（修 Dashboard 技术栈描述）

## 详细步骤

### 10.1 数据层：description 字段

- [ ] `src/core/storage.ts` — 迁移增加 `description` 列：

  ```sql
  -- 向后兼容：ALTER TABLE ADD COLUMN 不影响已有数据
  ALTER TABLE connections ADD COLUMN description TEXT;
  ```

  放在 `runMigration` 末尾，用 try/catch 包裹（列已存在时静默跳过），确保幂等。

- [ ] `src/core/connection.ts` — 三个接口增加 `description`：

  ```ts
  export interface ConnectionInput {
    // ...existing fields
    description?: string;
  }

  export interface Connection {
    // ...existing fields
    description?: string;
  }

  export interface ConnectionInfo {
    // ...existing fields
    description?: string;
  }
  ```

- [ ] `src/core/connection.ts` — `createConnection` INSERT 加 `description` 列
- [ ] `src/core/connection.ts` — `getConnection` 映射 `description` 字段
- [ ] `src/core/connection.ts` — `listConnections` 映射 `description` 字段
- [ ] `src/core/connection.ts` — `updateConnection` 支持 `patch.description`

### 10.2 CLI 参数：项目级默认值

- [ ] `src/cli/commands/client.ts` — 新增两个可选参数：

  ```ts
  export const clientCommand = new Command("client")
    .description("启动 MCP Stdio 服务")
    .option("--default-connection <name>", "默认连接名（项目级 MCP 配置）")
    .option("--default-schema <schema>", "默认 schema（项目级 MCP 配置）")
    .action(
      async (opts: { defaultConnection?: string; defaultSchema?: string }) => {
        // CLI 参数 > 环境变量
        const defaultConnection =
          opts.defaultConnection ?? process.env.XM_SQL_MCP_DEFAULT_CONNECTION;
        const defaultSchema =
          opts.defaultSchema ?? process.env.XM_SQL_MCP_DEFAULT_SCHEMA;

        // ...existing code...
        const mcp = createMcpServer({
          getRawDb: () => storage.raw,
          getMasterKey: () => masterKey,
          defaultConnection, // 新增
          defaultSchema, // 新增
        });
      },
    );
  ```

- [ ] 等价环境变量：`XM_SQL_MCP_DEFAULT_CONNECTION`、`XM_SQL_MCP_DEFAULT_SCHEMA`
- [ ] 启动日志打印默认值（如果有）：`logger.info({ defaultConnection, defaultSchema }, "Project defaults loaded")`

### 10.3 MCP Server：默认值注入

- [ ] `src/mcp/server.ts` — `McpServerDeps` 扩展：

  ```ts
  export interface McpServerDeps {
    getRawDb: () => BetterSqlite3.Database;
    getMasterKey: () => Buffer;
    defaultConnection?: string;
    defaultSchema?: string;
  }
  ```

- [ ] `src/mcp/server.ts` — `list_connections` handler 传入默认值，返回结构变更：

  ```ts
  // list-connections.ts
  return success(
    {
      ...(deps.defaultConnection || deps.defaultSchema
        ? {
            defaultConnection: deps.defaultConnection,
            defaultSchema: deps.defaultSchema,
          }
        : {}),
      connections: connections.map((c) => ({
        name: c.name,
        host: c.host,
        port: c.port,
        username: c.username,
        defaultSchema: c.defaultSchema,
        policy: c.policy,
        description: c.description, // 新增
      })),
    },
    handlerCtx.auditId,
  );
  ```

- [ ] `src/mcp/server.ts` — `list-connections` deps 类型扩展，传入 `defaultConnection` / `defaultSchema`

- [ ] `src/mcp/server.ts` — 其余 4 个带 `connection` 参数的工具，description 动态注入：

  ```ts
  const connDesc = deps.defaultConnection
    ? `Connection alias name. Default: "${deps.defaultConnection}"`
    : "Connection alias name (from list_connections)";
  ```

  涉及工具：`execute_sql`、`explain_sql`、`list_tables`、`describe_table`

### 10.4 CLI 命令：description 交互

- [ ] `src/cli/commands/setup.ts` — 在"默认数据库"步骤后增加：

  ```ts
  const description = await input({
    message: "连接描述（可选，如"项目A开发库"）:",
  });
  ```

  传入 `createConnection` 的 `description` 字段。

- [ ] `src/cli/commands/conn.ts` — `conn add` 增加 description 输入
- [ ] `src/cli/commands/conn.ts` — `conn edit` 增加 description 编辑（留空不修改，特殊标记清空）
- [ ] `src/cli/commands/conn.ts` — `conn list` 展示 description（截断显示）

### 10.5 Dashboard 适配

- [ ] `src/web/api/connections.ts` — POST/PATCH 接受 `description` 字段
- [ ] `src/web/frontend/index.ts` — 连接列表表格加"描述"列
- [ ] `src/web/frontend/index.ts` — 新建连接 modal 加 description input
- [ ] `src/web/frontend/index.ts` — 增加编辑连接 modal（当前只有新建和删除）

### 10.6 文档漂移修复

- [ ] `docs/adr/0012-misc-decisions.md` — License 从 Apache 2.0 改为 MIT（与 `LICENSE` 文件一致）
- [ ] `docs/ARCHITECTURE.md` §3.2 — Dashboard 描述从 "Next.js App (SSR/CSR)" 改为 "嵌入式 SPA（纯 HTML/CSS/JS，无构建步骤）"

### 10.7 测试

- [ ] `tests/unit/core/storage-migration.test.ts` — 验证迁移幂等性（description 列重复添加不报错）
- [ ] `tests/unit/core/connection.test.ts` — 增加：
  - `createConnection` 带 description / 不带 description
  - `listConnections` 返回 description 字段
  - `updateConnection` 修改 description
  - `updateConnection` 清空 description（传 `null` 或空字符串）
- [ ] `tests/mcp/tools.test.ts` — 增加：
  - `list_connections` 返回 `defaultConnection` / `defaultSchema`（有默认值时）
  - `list_connections` 不含默认值字段（无默认值时）
  - `list_connections` 每条连接包含 `description`

## 验收

```bash
pnpm test:unit tests/unit/core/connection.test.ts
pnpm test:unit tests/unit/core/storage-migration.test.ts
pnpm test:unit tests/mcp
pnpm build
```

手动验证：

```bash
# 1. 创建带 description 的连接
xm-sql-mcp setup   # 应出现"连接描述"输入步骤

# 2. 查看 description
xm-sql-mcp conn list   # 应显示描述

# 3. CLI 参数传递默认值
xm-sql-mcp client --default-connection mydev --default-schema app_a
# list_connections 应返回 { defaultConnection: "mydev", defaultSchema: "app_a", connections: [...] }

# 4. Dashboard 展示
xm-sql-mcp dashboard
# 连接列表应有"描述"列
```
