# 0008: 策略引擎规则集 + 单用户审批工作流

**Status**: Accepted
**Date**: 2026-06-02

## Context

Q11 讨论中确定了三件事：

1. **策略引擎全部用规则**，包括多语句检查、parse 失败、approved task override。这些不写在 `evaluate` 函数顶层的硬编码 if-else，而是统一用 `PolicyRule` 接口，作为内置规则（built-in）注册到规则链。用户可以在 Web 面板调整规则顺序、修改参数、关闭非安全护栏规则。

2. **决策类型扩展**为三种：`allow` / `deny` / `need_approval`。前两种覆盖 [ADR-0002](./0002-policy-engine-ast-and-grant.md) 已定的策略，第三种触发审批工作流。

3. **审批机制进入 v1**。Client 模式 + 单用户场景下，审批本质是"开发者审批自己 AI 的请求"——human-in-the-loop 模式。这参考了 [`tabularis`](https://github.com/TabularisDB/tabularis) 的思路，在 Client 单用户场景下仍有意义：防 AI 偶尔的愚蠢，而非防恶意用户。

## Decision

### 决策类型

```ts
export const DecisionKind = {
  Allow: "allow",
  Deny: "deny",
  NeedApproval: "need_approval",
} as const;

export type PolicyDecision =
  | { kind: typeof DecisionKind.Allow }
  | { kind: typeof DecisionKind.Deny; rule: string; reason: string }
  | { kind: typeof DecisionKind.NeedApproval; rule: string; reason: string };
```

### 规则接口

```ts
export interface PolicyRule {
  name: string;
  description: string;
  builtIn?: boolean; // 内置规则,用户不能删除,但可调整部分参数与顺序
  required?: boolean; // required=true 的规则不可关闭、不可移到非首位(如安全护栏)
  evaluate(ast: AST, ctx: PolicyContext): PolicyDecision | null;
  // null = 该规则不适用此 SQL,传给下一条
}
```

### v1 内置规则集

按评估顺序：

| #   | 规则名                          | required | 作用                                                     |
| --- | ------------------------------- | -------- | -------------------------------------------------------- |
| 1   | `approved-task-override`        | ✅       | 若该 SQL 有近期 approved 任务,直接放行(防止再次触发审批) |
| 2   | `parse-error`                   | ✅       | AST 解析失败 → Deny (fail-secure)                        |
| 3   | `multi-statement`               | ✅       | 多语句 SQL → Deny                                        |
| 4   | `enforce-statement-types`       | ❌       | 检查语句类型是否在 allowed 集合内(覆盖 S-02 / S-05)      |
| 5   | `need-approval-statement-types` | ❌       | 检查语句类型是否在 approval-required 集合内(覆盖 AP-02)  |
| 6   | `block-statement-types`         | ❌       | 检查语句类型是否在 blocked 集合内(覆盖 S-01)             |
| 7   | `enforce-limit`                 | ❌       | 强制 SELECT 有 LIMIT 且 ≤ 上限(覆盖 S-03)                |

规则 1-3 是安全护栏，不能关、不能挪。规则 4-7 可关可调序。

### 默认策略预设

```ts
const PRESETS = {
  // dev-default: DML 自由, DDL 需审批, 危险操作禁止
  "dev-default": {
    allowedStatementTypes: [
      "select",
      "insert",
      "update",
      "delete",
      "create_table",
      "create_index",
      "drop_table",
      "alter_table",
      "drop_index",
      "show_tables",
      "show_columns",
      "show_create_table",
    ],
    needApprovalStatementTypes: [
      "create_table",
      "drop_table",
      "alter_table",
      "create_index",
      "drop_index",
    ],
    blockedStatementTypes: [
      "drop_database",
      "drop_schema",
      "truncate",
      "grant",
      "revoke",
      "call",
      "create_database",
      "alter_database",
    ],
    enforceLimit: true,
    maxLimit: 1000,
  },

  // readonly-strict: 全只读
  "readonly-strict": {
    allowedStatementTypes: [
      "select",
      "show_tables",
      "show_columns",
      "show_create_table",
    ],
    needApprovalStatementTypes: [],
    blockedStatementTypes: [
      "drop_database",
      "drop_schema",
      "truncate",
      "grant",
      "revoke",
      "call",
      "create_database",
      "alter_database",
    ],
    enforceLimit: true,
    maxLimit: 500,
  },

  // demo-loose: 全允许,仅极端危险需审批
  "demo-loose": {
    allowedStatementTypes: ["<all>"],
    needApprovalStatementTypes: ["drop_database", "drop_schema", "truncate"],
    blockedStatementTypes: [],
    enforceLimit: true,
    maxLimit: 100,
  },
};
```

`xm-sql-mcp setup` 时让用户从预设中选,之后可微调。

### 审批工作流(方案 1: AI 主动 retry)

#### 流程

```
1. AI 调 execute_sql("DELETE FROM users WHERE ...")
2. 策略引擎评估 → need_approval (触发 need-approval-statement-types)
3. XM-SQL-MCP 创建 approval_task (status=pending, 24h 后过期)
4. 工具立即返回错误:
   {
     "error": {
       "code": "NEED_APPROVAL",
       "message": "This SQL requires approval...",
       "detail": { "taskId": "01HXY...", "approvalUrl": "http://localhost:9020/approve/01HXY..." }
     }
   }
5. AI 在 chat 里告诉用户:"需要审批, 请访问 http://localhost:9020/approve/01HXY..."
6. 用户打开 dashboard, 看到 SQL, 选择 同意 / 拒绝 / 修改后同意
7. 任务状态变为 approved, modified_sql 字段可能填充
8. 用户在 chat 里告诉 AI:"已审批"
9. AI 再次调 execute_sql(相同 SQL)
10. approved-task-override 规则识别 → 若 modified_sql 存在则替换 → 放行
11. 执行 SQL, 返回结果
12. 任务状态变为 consumed(防止重放)
```

#### `approval_tasks` 表

```sql
CREATE TABLE approval_tasks (
  id              TEXT PRIMARY KEY,           -- ULID
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,              -- 默认 created_at + 24h

  connection_name TEXT NOT NULL,
  sql             TEXT NOT NULL,
  sql_hash        TEXT NOT NULL,              -- sha256(sql), 用于 approved-task-override 快速查找
  statement_type  TEXT NOT NULL,
  trigger_rule    TEXT NOT NULL,

  status          TEXT NOT NULL,              -- 'pending' | 'approved' | 'denied' | 'expired' | 'consumed'
  decided_at      TEXT,
  decider_kind    TEXT,                       -- 'web_user' (v1 只有这种)
  modified_sql    TEXT,                       -- 审批时改过 SQL 才有
  decision_note   TEXT,

  audit_id        TEXT                        -- 审批行为本身的 audit_log.id
);

CREATE INDEX idx_approval_tasks_sql_hash ON approval_tasks(sql_hash, connection_name, status);
CREATE INDEX idx_approval_tasks_status ON approval_tasks(status, expires_at);
```

#### 过期任务清理

- 后台 job 每小时跑一次:`UPDATE approval_tasks SET status='expired' WHERE status='pending' AND expires_at < now()`
- 30 天以上的 expired/denied/consumed 任务,由 Web 面板的"清理审计"按钮一并清理(与 audit_log 同一清理入口)
- 不做自动彻底删除,只标 status

#### `check_task_status` 工具(MCP 工具新增)

```ts
// Input
{ taskId: string }

// Output (status=pending)
{
  status: 'pending',
  expiresAt: '2026-06-03T10:00:00Z',
  sql: 'DELETE FROM users WHERE ...',
  triggerRule: 'need-approval-statement-types',
}

// Output (status=approved)
{
  status: 'approved',
  decidedAt: '2026-06-02T15:30:00Z',
  modifiedSql: null,         // 若 modified 则有值
}

// Output (status=denied)
{
  status: 'denied',
  decidedAt: '...',
  decisionNote: '只允许删 7 天内的数据',
}

// Output (status=expired)
{
  status: 'expired',
  expiresAt: '...',
}
```

AI 用它查"我之前的请求批了吗",或主动告知用户"已经等了 X 分钟还没批"。

#### Web 审批页面

- `/approve/[taskId]` — 单任务快速审批页,从 AI 给的 URL 直接进
- `/approvals` — 审批队列(列出所有 pending 和最近 30 天历史)

页面展示 SQL(语法高亮)、触发规则、连接名、语句类型、过期时间。
按钮:**同意 / 拒绝 / 修改后同意**(允许编辑 SQL)。

#### 决策类型扩展

为支持"修改 SQL 后同意",`PolicyDecision.Allow` 需要扩展:

```ts
| { kind: typeof DecisionKind.Allow; modifiedSql?: string }
```

`approved-task-override` 规则在匹配到 approved 任务时,把 `modified_sql` 通过 `modifiedSql` 传递给执行层,执行层用 `modifiedSql ?? ctx.sql` 作为最终执行的 SQL。

### 审计联动

- **审批请求创建**: 写一条 audit_log,记录"AI 触发审批,任务 ID=xxx,SQL=xxx"
- **审批决定**: 写一条 audit_log,记录"用户 approve/deny 任务 ID=xxx,modified_sql=xxx"
- **任务 consumed**: 写一条 audit_log,记录"任务 ID=xxx 被使用,执行结果=xxx"

每次审批相关事件都有完整审计,不可篡改(走 [ADR-0004](./0004-audit-log-design.md) 的 hash 链)。

## Consequences

**正面**:

- 默认"允许 + 需审批"模型对开发者友好,日常 CRUD 不打扰,危险操作有刹车。
- "Single-user human-in-the-loop approval"是原创叙事,作品集 README 上有故事可讲。
- 规则引擎全部统一接口,后续新增策略(如表级权限、行级权限)只需新增规则模块。
- `tabularis` 启发 + XM-SQL-MCP 实现,在 MCP 生态里有清晰的差异化。

**已接受的代价**:

- v1 工作量增加约 5-6 天(approval_tasks 表、规则、Web 审批页、check_task_status 工具)。
- AI 需要正确处理 NEED_APPROVAL 错误才能完成工作流。Claude Code / Codex 在 prompt 引导下能稳定处理,但弱模型可能直接 retry 失败。**README 需要给 AI 一段 system prompt 提示词示例**,引导其正确处理审批流程。
- 审批任务 24h 过期可能让"周五下班前提的审批周一找不到"——这是有意设计,用户周一需要重新让 AI 提交。

**未来重新审视的触发条件**:

- Server 模式上线(v2):审批模型从 self-approve 升级为 role-approve,需要重新设计 decider 角色。
- 出现批量审批需求:加批量同意/拒绝 UI。
- 审批负载很高:增加 Webhook 通知(原 AP-05)。
