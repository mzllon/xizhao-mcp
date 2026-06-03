# Stage 08：Self-approval 工作流

> **输入：** Stage 04 策略引擎 + Stage 07 MCP 服务
> **输出：** 完整的 self-approval 闭环（创建任务 → Dashboard 审批 → AI retry → 执行）
> **依赖：** Stage 04、07
> **关联 ADR：** [0008](../adr/0008-policy-rules-and-approval-workflow.md)

## 目标

把"AI 提出危险 SQL" → "开发者审批" → "AI 执行"的闭环跑通。这是 v1 的核心安全叙事。

## 文件清单

- 修改：`src/core/policy/rules/approved-task-override.ts`（stage 04 留了骨架，本阶段补完）
- 修改：`src/core/policy/rules/need-approval-statement-types.ts`（补完）
- 修改：`src/mcp/tools/execute-sql.ts`（接入审批流）
- 创建：`src/core/approval.ts`
- 创建：`src/mcp/tools/check-task-status.ts`（实现）
- 创建：`tests/unit/core/approval.test.ts`
- 创建：`tests/integration/approval-flow.test.ts`

## 详细步骤

### 8.1 approval_tasks 表操作

- [ ] `src/core/approval.ts`：
  ```ts
  // 创建审批任务
  export function createApprovalTask(input: {
    sql: string;
    sqlHash: string;            // sha256(sql),用于 approved-task-override 匹配
    connectionName: string;
    statementType: string;
    triggerRule: string;
    triggerReason: string;
  }): ApprovalTask
  
  // 查 pending task by id
  export function getTask(id: string): ApprovalTask | null
  
  // 列 pending tasks（Dashboard 用）
  export function listPendingTasks(): ApprovalTask[]
  
  // 列近期历史（Dashboard 用,30 天内）
  export function listRecentTasks(limit: number): ApprovalTask[]
  
  // 审批通过（可带 modified_sql）
  export function approveTask(id: string, opts: { modifiedSql?: string; note?: string }): void
  
  // 审批拒绝
  export function denyTask(id: string, opts: { note?: string }): void
  
  // 标记 consumed（执行后调用,防止重放）
  export function consumeTask(id: string): void
  
  // 标记过期（后台 job）
  export function expireOverdueTasks(now: Date): number
  ```

### 8.2 状态机

- [ ] 状态流转：
  ```
  pending ──approve──> approved ──consume──> consumed
     │                                       │
     │──deny────────> denied                 │
     │                                       │
     └──expire────> expired                  │
                                              │
  （任何非 approved 状态都不能 consume）      │
  ```
- [ ] **不变量**：
  - 只能从 pending → 其他状态
  - approved → consumed 是单向
  - consumed / denied / expired 是终态

### 8.3 触发流程

- [ ] 修改 `src/mcp/tools/execute-sql.ts`：
  ```ts
  const decision = evaluate(sql, ctx);
  
  if (decision.kind === 'need_approval') {
    const sqlHash = sha256(sql);
    const task = createApprovalTask({
      sql,
      sqlHash,
      connectionName: conn.name,
      statementType: getStatementType(ast),
      triggerRule: decision.rule,
      triggerReason: decision.reason,
    });
    
    return error('NEED_APPROVAL',
      `This SQL requires approval. Task ID: ${task.id}`,
      auditId,
      {
        taskId: task.id,
        triggerRule: decision.rule,
        triggerReason: decision.reason,
        approvalUrl: `http://localhost:9020/approve/${task.id}`,
        expiresAt: task.expiresAt,
      }
    );
  }
  
  if (decision.kind === 'allow') {
    const sqlToExecute = decision.modifiedSql ?? sql;
    const result = await executeSql(conn, sqlToExecute);
    // 如果是 approved task 重放,标记 consumed
    // (这里 approved-task-override 规则已经在策略层处理匹配)
    return success({ ...result, auditId });
  }
  ```

### 8.4 approved-task-override 规则

- [ ] 补完 stage 04 留的骨架：
  ```ts
  export const approvedTaskOverride: PolicyRule = {
    name: 'approved-task-override',
    description: 'If this exact SQL has a recent approved task, allow it.',
    builtIn: true,
    required: true,
    evaluate(ast, ctx) {
      const task = db.queryOne(
        `SELECT id, modified_sql FROM approval_tasks
         WHERE sql_hash = ? AND connection_name = ? AND status = 'approved'
         AND decided_at > datetime('now', '-1 hour')`,
        [ctx.sqlHash, ctx.connection.name]
      );
      
      if (task) {
        // 立即标记 consumed,防止重放（同事务）
        db.execute(
          `UPDATE approval_tasks SET status = 'consumed' WHERE id = ?`,
          [task.id]
        );
        
        return {
          kind: DecisionKind.Allow,
          modifiedSql: task.modified_sql ?? undefined,
        };
      }
      return null;
    },
  };
  ```

### 8.5 check_task_status 工具

- [ ] `src/mcp/tools/check-task-status.ts`：
  ```ts
  const CheckTaskStatusSchema = z.object({
    taskId: z.string().describe('Approval task ID returned from execute_sql'),
  });
  
  export const checkTaskStatusTool = {
    name: 'check_task_status',
    description: 'Check the approval status of a previously submitted SQL.',
    inputSchema: zodToJsonSchema(CheckTaskStatusSchema),
    handler: withAudit('check_task_status', async (args) => {
      const { taskId } = CheckTaskStatusSchema.parse(args);
      const task = getTask(taskId);
      if (!task) return error('TASK_NOT_FOUND', '...', auditId);
      
      return success({
        status: task.status,        // pending / approved / denied / expired / consumed
        sql: task.sql,
        modifiedSql: task.modified_sql,
        triggerRule: task.trigger_rule,
        expiresAt: task.expires_at,
        decidedAt: task.decided_at,
        decisionNote: task.decision_note,
      }, auditId);
    }),
  };
  ```

### 8.6 后台过期 job

- [ ] 在 `xizhao client` 启动时启动一个 setInterval：
  ```ts
  // 每小时跑一次
  setInterval(() => {
    const count = expireOverdueTasks(new Date());
    if (count > 0) {
      logger.info({ count }, 'Expired overdue approval tasks');
    }
  }, 60 * 60 * 1000);
  ```
- [ ] 也加到 Dashboard 进程（两个进程都会跑，幂等）

### 8.7 审计事件

- [ ] 三类审批事件必须写审计：
  - **审批请求创建**：`audit_log.tool = 'approval.create'` + `policy_decision = 'need_approval'`
  - **审批决定**：`audit_log.tool = 'approval.decide'` + 包含 decider、modified_sql、note
  - **任务 consumed**：`audit_log.tool = 'approval.consume'` + 包含 task_id、execution 结果
- [ ] 在 `appendAuditLog` 现有结构上加 `tool` 枚举值（不破坏 schema）

### 8.8 测试

- [ ] **单元测试**：
  - 创建 task → 字段正确
  - approve → status 变为 approved
  - deny → status 变为 denied
  - 过期 job → status 变为 expired
  - consume 只能从 approved → consumed
  - 重复 consume 抛错
- [ ] **集成测试**：
  - `tests/integration/approval-flow.test.ts`：
    1. AI 调 execute_sql 触发 need_approval
    2. 用 mock Dashboard 调 approve API
    3. AI 再次调相同 SQL → 应该自动 consume 并执行
    4. 第三次调相同 SQL → 应该再次触发 need_approval（task 已 consume）
  - 测试 modified_sql 流转：
    1. AI 调 DROP TABLE users
    2. 用户审批时改为 DROP TABLE temp_users
    3. AI retry → 应执行 DROP TABLE temp_users（不是原 SQL）
  - 测试 24h 过期：
    1. 创建 task
    2. mock 时间前进 25 小时
    3. 跑过期 job → task 标记 expired
    4. AI retry → 创建新 task

## 验收

```bash
pnpm test:unit tests/unit/core/approval.test.ts
pnpm test:integration tests/integration/approval-flow.test.ts
pnpm test:coverage -- src/core/approval.ts src/core/policy/rules/approved-task-override.ts
```

预期：
- 所有测试通过
- `src/core/approval.ts` 覆盖率 ≥ 90%
- 完整流程：DDL 触发审批 → 批准 → retry → 执行 → consumed
- modified_sql 正确流转
- expired 状态正确处理

## 关键技术点

### 防止重放

- approved 状态的 task **只能用一次**
- consume 操作在 approved-task-override 规则内**同事务**完成
- 防止两个并发请求同时使用同一 task

### sql_hash 的用途

- 不是为了安全（sha256 已够）
- 是为了**快速查找**：indexed hash 列 + connection_name + status 比 LIKE 匹配 SQL 文本快 1000 倍
- `approval_tasks` 表必须有 `(sql_hash, connection_name, status)` 索引

### modified_sql 的语义

- 修改 SQL 是 **allow 决策的副作用**，不是 NeedApproval
- `approved-task-override` 返回 `{ kind: 'allow', modifiedSql: '...' }`
- 执行层使用 `decision.modifiedSql ?? sql`
- 这样策略引擎依然纯粹（不执行 SQL），只是给出建议

### 审批 URL 的可移植性

- `approvalUrl: 'http://localhost:9020/approve/<id>'` 是硬编码
- Server 模式（v2）需要根据实际部署地址生成
- v1 Client 模式 localhost 即可

## 实施风险

| 风险 | 应对 |
|------|------|
| 两个进程同时 consume 同一 task | SQLite 事务 + `status = 'approved'` 条件更新保证原子性 |
| 后台 job 在两个进程同时跑 | 幂等（UPDATE WHERE status='pending' AND expires_at < ?），不冲突 |
| AI 收到 NEED_APPROVAL 后无限重试 | Dashboard 在审批期间显示"AI 正在等待"；AI 应该收到 check_task_status 的 expired 状态后放弃 |
| modified_sql 被审批人改坏 | 审批时显示 EXPLAIN 警告；最终执行失败由 MySQL 错误反馈 |
