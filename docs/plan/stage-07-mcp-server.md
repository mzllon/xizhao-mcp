# Stage 07：MCP 服务与工具

> **输入：** Stage 04 策略引擎 + Stage 05 审计 + Stage 06 MySQL
> **输出：** 完整的 Stdio MCP Server（6 个工具，含 list_connections）+ AsyncLocalStorage + withAudit 中间件
> **依赖：** Stage 04、05、06
> **关联 ADR：** [0010](../adr/0010-mcp-implementation.md)、[0003](../adr/0003-authoritative-source-principle.md)

## 目标

实现 v1 的对外契约——MCP 工具集。AI 客户端（Claude Code / Codex / Cursor）通过这些工具访问 MySQL。所有调用必经策略引擎、必写审计。

## 文件清单

- 创建：`src/mcp/server.ts`
- 创建：`src/mcp/context.ts`（AsyncLocalStorage）
- 创建：`src/mcp/response.ts`（成功/错误响应工具函数）
- 创建：`src/mcp/middleware/audit.ts`（withAudit wrapper）
- 创建：`src/mcp/tools/execute-sql.ts`
- 创建：`src/mcp/tools/explain-sql.ts`
- 创建：`src/mcp/tools/list-tables.ts`
- 创建：`src/mcp/tools/describe-table.ts`
- 创建：`src/mcp/tools/check-task-status.ts`
- 创建：`src/cli/commands/client.ts`（实现，覆盖 stage 03 占位）
- 创建：`tests/mcp/tools.test.ts`
- 创建：`tests/mcp/protocol.test.ts`

## 详细步骤

### 7.1 AsyncLocalStorage 上下文

- [ ] `src/mcp/context.ts`：

  ```ts
  import { AsyncLocalStorage } from "node:async_hooks";

  export interface RequestContext {
    clientInfo?: { name: string; version: string };
    auditId?: string;
    connectionName?: string;
  }

  export const requestContext = new RequestContextStorage();

  class RequestContextStorage extends AsyncLocalStorage<RequestContext> {
    getClientInfo(): { name: string; version: string } | undefined {
      return this.getStore()?.clientInfo;
    }
    getAuditId(): string | undefined {
      return this.getStore()?.auditId;
    }
  }
  ```

- [ ] 在 stage 05 的 logger 中使用 `requestContext.getClientInfo()` 注入到 pino

### 7.2 MCP Server 启动

- [ ] `src/mcp/server.ts`：

  ```ts
  import { Server } from "@modelcontextprotocol/sdk/server/index.js";
  import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
  import { requestContext } from "./context.js";

  export function createMcpServer() {
    const server = new Server(
      { name: "xm-sql-mcp", version: VERSION },
      { capabilities: { tools: {} } },
    );

    // 注册工具

    server.oninitialize = (req) => {
      const clientInfo = req.params.clientInfo;
      // 进入 request scope,后续 handler 可通过 AsyncLocalStorage 取
      return requestContext.run({ clientInfo }, () => ({
        capabilities: { tools: {} },
      }));
    };

    return server;
  }

  export async function runMcpServer() {
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
  ```

- [ ] **关键约束**：
  - stdout 严格纯净（MCP 协议占用）
  - 所有 console.log/error 必须走 pino（自动输出到 stderr）
  - 调试时用 `--verbose` 看完整日志

### 7.3 Tool 注册

- [ ] 每个工具用 Zod 定义 input schema：

  ```ts
  // src/mcp/tools/execute-sql.ts
  import { z } from "zod";
  import { zodToJsonSchema } from "zod-to-json-schema";

  const ExecuteSqlSchema = z.object({
    connection: z.string().describe("Connection alias"),
    sql: z.string().min(1).describe("Single SQL statement"),
  });

  export const executeSqlTool = {
    name: "execute_sql",
    description: "Execute a single SQL statement...",
    inputSchema: zodToJsonSchema(ExecuteSqlSchema),
    handler: withAudit("execute_sql", async (args, ctx) => {
      const parsed = ExecuteSqlSchema.parse(args);
      // ...策略评估 + mysql 执行
    }),
  };
  ```

- [ ] 6 个工具：
  - `list_connections`：{} → { connections[] } — **必须第一个调用，发现可用连接**
  - `execute_sql`：{ connection, sql } → 结果（参考 stage 06 SqlResult）
  - `explain_sql`：{ connection, sql } → { plan }
  - `list_tables`：{ connection, schema? } → { tables[] }
  - `describe_table`：{ connection, table } → { ddl, rowCount? }
  - `check_task_status`：{ taskId } → { status, ... }

### 7.4 withAudit 中间件

- [ ] `src/mcp/middleware/audit.ts`：
  ```ts
  export function withAudit<TIn, TOut>(
    toolName: string,
    handler: (args: TIn, ctx: ToolContext) => Promise<TOut>,
  ) {
    return async (args: TIn, ctx: ToolContext) => {
      const auditId = ulid();
      const entry = createAuditEntry({ tool: toolName, args, ctx, auditId });
      try {
        const result = await requestContext.run(
          {
            ...requestContext.getStore(),
            auditId,
            connectionName: ctx.connection?.name,
          },
          () => handler(args, ctx),
        );
        entry.complete({ status: "success", result });
        return result;
      } catch (e) {
        entry.complete({ status: "error", error: e });
        throw e;
      } finally {
        try {
          await entry.flush(); // fail-on-audit-failure
        } catch (auditErr) {
          // 审计写失败:抛 INTERNAL_ERROR,不返回业务结果
          throw new XmSqlMcpError("AUDIT_WRITE_FAILED");
        }
      }
    };
  }
  ```

### 7.5 响应格式

- [ ] `src/mcp/response.ts`：

  ```ts
  // 成功
  export function success(data: unknown, auditId: string) {
    return {
      content: [
        { type: "text", text: JSON.stringify({ data, auditId }, null, 2) },
      ],
    };
  }

  // 失败
  export function error(
    code: ErrorCode,
    message: string,
    auditId: string,
    detail?: unknown,
  ) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { error: { code, message, detail }, auditId },
            null,
            2,
          ),
        },
      ],
    };
  }
  ```

- [ ] 错误码统一：`NEED_APPROVAL` / `POLICY_VIOLATION` / `MYSQL_ERROR` / `TIMEOUT` / `MULTI_STATEMENT_NOT_SUPPORTED` / `SQL_PARSE_ERROR` / `CONNECTION_NOT_FOUND` / `INTERNAL_ERROR` / `SQL_SYNTAX_ERROR` / `SERVER_SHUTTING_DOWN`
- [ ] 不使用 `_meta` 承载关键数据（自包含 content text）

### 7.6 execute_sql 完整流程

- [ ] handler 实现：
  1. Zod 校验 args
  2. 查 connection（getConnection(name)）
  3. 评估策略（evaluate(sql, ctx)）
     - Deny → 返回 `POLICY_VIOLATION` 错误
     - NeedApproval → 创建 task、返回 `NEED_APPROVAL` 错误（含 taskId + approvalUrl）
     - Allow → 继续执行
  4. 用 modifiedSql（如果有）替代原 sql
  5. 调 executeSql(conn, sql)
  6. 成功 → success({ ...result, auditId })

### 7.7 优雅关闭

- [ ] `src/cli/commands/client.ts` 实现：

  ```ts
  let shuttingDown = false;
  const inflight = new Set<Promise<unknown>>();

  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn({ signal }, "Shutting down...");

    // 1. 拒绝新请求(由 handler 检查 shuttingDown 标志)
    // 2. 等待 in-flight 最长 5 秒
    await Promise.race([
      Promise.allSettled([...inflight]),
      new Promise((r) => setTimeout(r, 5000)),
    ]);

    // 3. 关闭 MySQL pool
    await closeAllPools();

    // 4. 关闭 SQLite
    closeStorage();

    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  ```

### 7.8 测试

- [ ] **tools.test.ts**：
  - 用 `@modelcontextprotocol/sdk` 的 Client 模拟调用
  - 测试每个工具的成功 / 失败
  - 测试 NEED_APPROVAL 返回结构
  - 测试 auditId 一致性（请求 ↔ 审计日志）
- [ ] **protocol.test.ts**：
  - 测试 initialize 握手捕获 clientInfo
  - 测试 Stdio 通信（mock stdin/stdout）
  - 测试 stdout 纯净度（无任何非 JSON-RPC 输出）
  - 测试 SIGINT 优雅关闭

## 验收

```bash
pnpm test:unit tests/mcp
pnpm build
node dist/cli/index.js client &
# 应该启动并等待 MCP 协议消息,stdout 完全纯净
kill -INT $!
# 应该优雅退出
```

预期：

- 所有测试通过
- 手动启动时 stdout 没有任何非 JSON-RPC 输出
- SIGINT 后进程在 5 秒内退出
- 审计日志记录了完整生命周期

## 关键技术点

### Stdio 的纯粹性

- stdout **只能**写 JSON-RPC 消息
- 任何 console.log 都破坏协议
- 必须用 pino 输出到 stderr
- 测试时用 `process.stdout.write = jest.fn()` mock 验证

### AsyncLocalStorage 跨 await

- Node 14+ AsyncLocalStorage 自动跨 await 传播
- 但 `setTimeout` / `setInterval` 回调不会自动继承
- 必要时用 `requestContext.bind(fn)` 包装

### MCP SDK 版本兼容

- `@modelcontextprotocol/sdk` 仍在快速迭代
- 锁定具体版本（如 `^1.0.0`），不在 minor 版本自动升级
- 升级前测试 5 个客户端兼容性

### Zod 到 JSON Schema 的细节

- `zod-to-json-schema` 对 `.describe()` 的处理是把它放到 `description` 字段
- AI 客户端读取 `description` 作为字段说明
- 必须为每个字段写 `.describe()`，否则 AI 不知道传什么

## 实施风险

| 风险                                 | 应对                                           |
| ------------------------------------ | ---------------------------------------------- |
| MCP SDK API 变更                     | 锁定版本，关注 release notes                   |
| AsyncLocalStorage 在某些异步路径丢失 | 集成测试覆盖关键路径                           |
| stdout 污染（如依赖库 console.log）  | 覆写 `console.log = () => {}` 在 client 启动时 |
| 优雅关闭时 in-flight 请求超时        | 5 秒兜底 + 审计记录"shutdown interrupted"      |
