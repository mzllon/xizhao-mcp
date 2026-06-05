# 0010: MCP 协议实现细节 —— SDK、Zod、审计中间件、错误格式

**Status**: Accepted
**Date**: 2026-06-02

## Context

v1 第一发布是 Client 模式（[ADR-0007](./0007-onboarding-and-client-first.md)），MCP 协议通过 Stdio 与客户端（Claude Code / Codex / Cursor）通信。这一层决定 v1 的代码骨架。

## Decision

### MCP SDK：官方 `@modelcontextprotocol/sdk`

不自实现协议层。SDK 由 Anthropic 维护，覆盖 Server / Client / Stdio / HTTP 全套。

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new Server(
  { name: "xm-sql-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);
```

### 工具参数校验：Zod

用 [`zod`](https://www.npmjs.com/package/zod) 定义 schema，用 [`zod-to-json-schema`](https://www.npmjs.com/package/zod-to-json-schema) 导出给 MCP 协议的 `inputSchema`。

```ts
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

const ExecuteSqlSchema = z.object({
  connection: z.string().describe('Connection alias'),
  sql: z.string().describe('Single SQL statement').min(1),
});

// 注册时给 MCP
inputSchema: zodToJsonSchema(ExecuteSqlSchema),

// handler 内
const parsed = ExecuteSqlSchema.parse(args);
// TS 类型自动推导: z.infer<typeof ExecuteSqlSchema>
```

**优点**：单一真相源。改 schema → TS 类型 + JSON Schema + 运行时校验同步。

### 审计写入：`withAudit` wrapper 中间件

不放在工具 handler 内（避免漏审计），不依赖 SDK 拦截器（耦合度高），用 wrapper 包裹每个 tool handler。

```ts
// mcp/middleware/audit.ts
export function withAudit<TIn, TOut>(
  toolName: string,
  handler: (args: TIn, ctx: ToolContext) => Promise<TOut>,
) {
  return async (args: TIn, ctx: ToolContext) => {
    const entry = createAuditEntry({ tool: toolName, args, ctx });
    try {
      const result = await handler(args, ctx);
      entry.complete({ status: "success", result });
      return result;
    } catch (e) {
      entry.complete({ status: "error", error: e });
      throw e;
    } finally {
      await entry.flush(); // fail-on-audit-failure (ADR-0004)
    }
  };
}

// 注册
const tools = {
  list_connections: {
    handler: withAudit("list_connections", listConnectionsHandler),
    inputSchema,
  },
  execute_sql: {
    handler: withAudit("execute_sql", executeSqlHandler),
    inputSchema,
  },
  explain_sql: {
    handler: withAudit("explain_sql", explainSqlHandler),
    inputSchema,
  },
  list_tables: {
    handler: withAudit("list_tables", listTablesHandler),
    inputSchema,
  },
  describe_table: {
    handler: withAudit("describe_table", describeTableHandler),
    inputSchema,
  },
  check_task_status: {
    handler: withAudit("check_task_status", checkTaskHandler),
    inputSchema,
  },
};
```

新 tool 注册时自动获得审计，业务 handler 不知道审计存在。

### 错误返回：JSON 字符串 in content

MCP 协议有两层错误：

- **协议错误**（JSON-RPC `error`）：仅用于 SDK 自身报错（method not found 等），不用业务错误
- **工具错误**（`CallToolResult.isError: true`）：业务错误全部走这里

格式：

```ts
{
  isError: true,
  content: [
    {
      type: 'text',
      text: JSON.stringify({
        error: {
          code: 'NEED_APPROVAL' | 'POLICY_VIOLATION' | 'MYSQL_ERROR' |
                'TIMEOUT' | 'MULTI_STATEMENT_NOT_SUPPORTED' |
                'SQL_PARSE_ERROR' | 'CONNECTION_NOT_FOUND' | 'INTERNAL_ERROR',
          message: '<AI-readable human message>',
          detail?: <optional structured info, e.g. { taskId, approvalUrl } for NEED_APPROVAL>,
        },
        auditId: '01HXZ...',
      }, null, 2),
    },
  ],
}
```

**关键约束**：

- 错误内容是 JSON 字符串，AI 解析准。
- 同一结构覆盖所有错误码。
- `message` 字段人话（"DROP DATABASE is blocked by policy 'block-statement-types'"），AI 也能直接转达给用户。
- `auditId` 必带，AI 可引用。

### 工具响应：auditId 自包含

成功响应同样在 content text 的 JSON 中带 `auditId`：

```ts
{
  content: [
    {
      type: 'text',
      text: JSON.stringify({
        data: { /* 工具实际结果 */ },
        auditId: '01HXZ...',
      }),
    },
  ],
}
```

**不用 MCP `_meta` 字段**——客户端不一定保留传递。自包含最稳。

### 客户端识别：AsyncLocalStorage

MCP `initialize` 请求带 `clientInfo: { name, version }`。用 Node `AsyncLocalStorage` 在 request scope 内传递，每个 handler 通过 `requestContext.getStore()?.clientInfo` 取。

```ts
import { AsyncLocalStorage } from "node:async_hooks";

interface RequestContext {
  clientInfo?: { name: string; version: string };
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

// 在 transport middleware 层 wrap
```

写入 audit_log 的 `mcp_client_id` 字段。

### v1 工具清单（最终）

| 工具                | 输入                      | 输出                                                                              |
| ------------------- | ------------------------- | --------------------------------------------------------------------------------- |
| `list_connections`  | `{}`                      | `{ connections: [{name, host, port, username, defaultSchema, policy}], auditId }` |
| `execute_sql`       | `{ connection, sql }`     | `{ kind, columns?, rows?, rowCount?, affectedRows?, truncated, auditId }`         |
| `explain_sql`       | `{ connection, sql }`     | `{ plan, warning?, auditId }`                                                     |
| `list_tables`       | `{ connection, schema? }` | `{ tables: [{name, type, rowCount?}], auditId }`                                  |
| `describe_table`    | `{ connection, table }`   | `{ ddl, rowCount?, auditId }`                                                     |
| `check_task_status` | `{ taskId }`              | `{ status, expiresAt?, decidedAt?, modifiedSql?, decisionNote?, auditId }`        |

**调用顺序**：AI 必须先调用 `list_connections` 发现可用连接名，再用 `connection` 参数调用其余工具。

砍掉 PRD 原列表中的：

- `list_my_tasks` (T-07) —— 与 `check_task_status` 重叠，AI 知道 taskId 直接查即可。

### Stdio 通信注意点

- **stdout 必须纯净**：MCP 用 stdout 传 JSON-RPC，**不能有任何 console.log 输出污染**。
- **所有日志走 stderr**：用 pino，输出到 stderr。`~/.xm-sql-mcp/logs/xm-sql-mcp.log` 文件同步写。
- **stdin 不读用户输入**：`xm-sql-mcp client` 启动后 stdin 完全归 MCP 协议使用，不允许任何 inquirer 交互（inquirer 仅在 `xm-sql-mcp setup` 等非 Stdio 命令中使用）。

## Consequences

**正面**：

- v1 代码骨架清晰：6 个 tool handler（含 list_connections）+ 1 个 wrapper + 1 套 schema + 1 个 AsyncLocalStorage。
- 审计与业务解耦，新 tool 自动获得审计。
- 错误格式结构化，AI 跨客户端行为可预测。
- TypeScript 严格类型贯穿 schema → handler → response。
- `list_connections` 让 AI 自主发现可用连接，无需开发者手动告知连接名。

**已接受的代价**：

- 工具响应 content text 是 JSON 字符串而非 plain text，某些 MCP 客户端在错误展示时把 JSON 当字面字符串显示给最终用户。AI 看到的是结构化的，但最终用户看到的可能是裸 JSON。**这是有意取舍**——AI 才是主要消费者。
- `_meta` 字段被弃用，丧失协议层的元信息传递能力。后续若 MCP 协议普及 `_meta`，再迁移。
- 砍掉 `list_my_tasks`，AI 必须通过 `check_task_status` 按 taskId 查询。

**未来重新审视的触发条件**：

- MCP 协议升级 → 跟进 SDK 版本，可能涉及 `_meta` 使用。
- Server 模式上线 → `list_connections` 需增加按用户可见性过滤。
- 出现 AI 反馈"找不到自己的任务" → 重新评估 `list_my_tasks`。
