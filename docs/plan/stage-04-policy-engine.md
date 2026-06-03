# Stage 04：策略引擎

> **输入：** Stage 02 存储就绪
> **输出：** 完整 AST 策略引擎（7 条规则）+ SQL 测试语料库 + property-based 测试
> **依赖：** Stage 02
> **关联 ADR：** [0002](../adr/0002-policy-engine-ast-and-grant.md)、[0008](../adr/0008-policy-rules-and-approval-workflow.md)

## 目标

实现 v1 安全核心。SQL 经过 AST 解析 → 规则链评估 → 返回 `allow` / `deny` / `need_approval`。覆盖 PRD 中 S-01 到 S-05 所有策略需求。

**这是技术含量最高的阶段，建议采用 L3 学习模式：让 AI 写实现，自己写 5+ 个探针实验验证理解。**

## 文件清单

- 创建：`src/core/policy/types.ts`
- 创建：`src/core/policy/presets.ts`
- 创建：`src/core/policy/index.ts`
- 创建：`src/core/policy/statement-type.ts`（AST 适配函数）
- 创建：`src/core/policy/rules/approved-task-override.ts`
- 创建：`src/core/policy/rules/parse-error.ts`
- 创建：`src/core/policy/rules/multi-statement.ts`
- 创建：`src/core/policy/rules/enforce-statement-types.ts`
- 创建：`src/core/policy/rules/need-approval-statement-types.ts`
- 创建：`src/core/policy/rules/block-statement-types.ts`
- 创建：`src/core/policy/rules/enforce-limit.ts`
- 创建：`tests/fixtures/sql/<category>/*.sql` + `*.json`
- 创建：`tests/unit/policy/statement-type.test.ts`
- 创建：`tests/unit/policy/rules.test.ts`
- 创建：`tests/unit/policy/evaluate.test.ts`
- 创建：`tests/unit/policy.property.test.ts`

## 详细步骤

### 4.1 类型定义

- [ ] `src/core/policy/types.ts`：
  ```ts
  export const DecisionKind = {
    Allow: 'allow',
    Deny: 'deny',
    NeedApproval: 'need_approval',
  } as const;
  
  export type PolicyDecision =
    | { kind: typeof DecisionKind.Allow; modifiedSql?: string }
    | { kind: typeof DecisionKind.Deny; rule: string; reason: string }
    | { kind: typeof DecisionKind.NeedApproval; rule: string; reason: string };
  
  export interface PolicyRule {
    name: string;
    description: string;
    builtIn?: boolean;
    required?: boolean;        // required=true 的不可关闭、不可移到非首位
    evaluate(ast: AST, ctx: PolicyContext): PolicyDecision | null;
  }
  
  export interface PolicyContext {
    sql: string;
    sqlHash: string;            // sha256(sql)，approved-task-override 用
    connection: { name: string; policy: PolicyConfig };
  }
  
  export interface PolicyConfig {
    allowedStatementTypes: StatementType[];
    needApprovalStatementTypes: StatementType[];
    blockedStatementTypes: StatementType[];
    enforceLimit: boolean;
    maxLimit: number;
  }
  
  export type StatementType =
    | 'select' | 'insert' | 'update' | 'delete'
    | 'create_table' | 'create_index' | 'create_view' | 'create_database'
    | 'drop_table' | 'drop_index' | 'drop_view' | 'drop_database' | 'drop_schema'
    | 'alter_table' | 'alter_database' | 'rename_table' | 'truncate'
    | 'show_tables' | 'show_databases' | 'show_columns' | 'show_create_table'
    | 'use' | 'set' | 'call'
    | 'grant' | 'revoke'
    | 'other';
  ```

### 4.2 AST 适配函数

- [ ] `src/core/policy/statement-type.ts`：
  - 实现 `getStatementType(ast: AST): StatementType`
  - 研究 `node-sql-parser` 的 AST 结构：`ast.type`（`select`/`insert`/`update`/`delete`/`create`/`drop`/`alter`/`truncate`/...）
  - 细分：`ast.type === 'create'` 时根据 `ast.keyword` 区分 `create_table` / `create_index` / `create_view` / `create_database`
  - 类似处理 `drop` / `alter`
  - 处理 SHOW 语句的不同变体
  - **重点：自己写 50 条 SQL 跑 parser，打印 AST 结构，理解后再写函数**

### 4.3 规则实现

- [ ] 按以下顺序实现 7 条规则（每条一个文件）：

#### Rule 1: `approved-task-override` (required)
- 检查 `ctx.sqlHash` 是否有匹配的 `approval_tasks` 记录（status=approved、未过期、连接匹配）
- 找到 → 返回 `Allow` + `modifiedSql`（如果审批时改了 SQL）
- 同时把 task 标记为 consumed（防止重放，事务性）
- 找不到 → 返回 `null`（传给下一条）

#### Rule 2: `parse-error` (required)
- 在 `evaluate()` 顶层捕获 parser 异常
- 失败 → `Deny('parse-error', 'SQL parse failed: <message>')`
- **这条不是普通规则，是在 parse 阶段的 try/catch**

#### Rule 3: `multi-statement` (required)
- `node-sql-parser` 返回数组时检查长度
- `length > 1` → `Deny('multi-statement', '...')`
- `length === 0` → `Deny('empty-input', '...')`

#### Rule 4: `enforce-statement-types`
- 检查 `getStatementType(ast)` 是否在 `ctx.connection.policy.allowedStatementTypes`
- 不在 → `Deny`
- 在 → 返回 `null`

#### Rule 5: `need-approval-statement-types`
- 检查 type 是否在 `needApprovalStatementTypes`
- 是 → `NeedApproval`
- 否 → `null`

#### Rule 6: `block-statement-types`
- 检查 type 是否在 `blockedStatementTypes`
- 是 → `Deny`
- 否 → `null`

#### Rule 7: `enforce-limit`
- 仅当 `policy.enforceLimit === true` 且 type === 'select'
- 检查 `ast.limit` 是否存在且 ≤ `maxLimit`
- 缺失 → `Deny('enforce-limit', 'SELECT without LIMIT is not allowed. Add LIMIT <max>.')`
- 超过 → `Deny('enforce-limit', 'LIMIT <n> exceeds maximum <max>.')`
- 通过 → `null`

### 4.4 评估流水线

- [ ] `src/core/policy/index.ts`：
  ```ts
  import { Parser } from 'node-sql-parser';
  
  const parser = new Parser();
  
  export function evaluate(sql: string, ctx: PolicyContext): PolicyDecision {
    let ast: AST;
    try {
      const result = parser.parse(sql, { database: 'MySQL' });
      // result 可能是 array 或 single object
      ast = Array.isArray(result) ? result[0] : result;
      // 但 multi-statement rule 需要看 array length
    } catch (e) {
      return { kind: 'deny', rule: 'parse-error', reason: String(e) };
    }
  
    // multi-statement check
    const parsed = parser.parse(sql, { database: 'MySQL' });
    const stmts = Array.isArray(parsed) ? parsed : [parsed];
    if (stmts.length > 1) {
      return { kind: 'deny', rule: 'multi-statement', reason: '...' };
    }
  
    // rule chain
    for (const rule of RULES) {
      const decision = rule.evaluate(ast, ctx);
      if (decision !== null) return decision;
    }
    return { kind: 'allow' };
  }
  ```
  **优化**：parse 只调用一次，结果传给所有规则。

### 4.5 预设

- [ ] `src/core/policy/presets.ts`：参考 [ADR-0008](../adr/0008-policy-rules-and-approval-workflow.md) line 38-65 实现 3 个预设

### 4.6 SQL Fixtures 语料库

- [ ] 创建 `tests/fixtures/sql/`，每个分类一个目录：
  - `select/`：basic / with-join / with-cte / with-subquery / no-limit / window-function
  - `insert/`：basic / on-duplicate-key / select-from
  - `update/`：basic / with-join / with-order-by-limit
  - `delete/`：basic / with-where / no-where
  - `ddl/`：create-table / drop-table / drop-database / alter-table-add-column / truncate / create-index
  - `dangerous/`：multi-statement / comment-bypass / case-bypass / unicode-whitespace / dynamic-sql / stacked-queries
  - `utility/`：show-tables / show-create-table / use / set
- [ ] 每个 `.sql` 文件配一个 `.json` 描述预期：
  ```json
  {
    "expectedStatementType": "drop_database",
    "expectedDecision": { "kind": "deny", "rule": "block-statement-types" }
  }
  ```
- [ ] 目标：**至少 50 条 SQL 样本**

### 4.7 测试

- [ ] **单元测试**：
  - `statement-type.test.ts`：对每个 fixture，验证 `getStatementType` 输出
  - `rules.test.ts`：每条规则至少 5 个 case（适用通过 / 适用拒绝 / 不适用 / 边界 / 已知绕过）
  - `evaluate.test.ts`：端到端，对每个 fixture 的 `.json` 预期决策进行断言
- [ ] **Property-based 测试**（`policy.property.test.ts`）：
  ```ts
  import { fc, test as fcTest } from '@fast-check/vitest';
  
  fcTest.prop({ sql: fc.string() })(
    'policy engine never throws on any string input',
    ({ sql }) => {
      expect(() => evaluate(sql, mockCtx)).not.toThrow();
    }
  );
  
  fcTest.prop({ sql: fc.string({ minLength: 1 }) })(
    'DROP DATABASE variants are always denied',
    ({ sql }) => {
      // 仅当 SQL 包含 DROP DATABASE 时断言
      if (/drop\s+database/i.test(sql)) {
        const result = evaluate(sql, mockCtx);
        expect(result.kind).toBe('deny');
      }
    }
  );
  ```

## 验收

```bash
pnpm test:unit tests/unit/policy
pnpm test:property
pnpm test:coverage -- src/core/policy
```

预期：
- 所有测试通过
- `src/core/policy/**` 覆盖率 ≥ 95%
- Property-based 跑 1000 次随机输入零异常

## 关键技术点

### node-sql-parser AST 结构

```ts
// SELECT * FROM users WHERE id = 1 LIMIT 10
{
  type: 'select',
  distinct: null,
  columns: [{ type: 'star' }],
  from: [{ table: 'users', as: null }],
  where: { type: 'binary_expr', operator: '=', left: {...}, right: {...} },
  limit: { separator: '', value: [{ type: 'number', value: 10 }] },
}

// CREATE TABLE foo (id INT)
{
  type: 'create',
  keyword: 'table',
  table: [{ table: 'foo', as: null }],
  create_definitions: [...]
}
```

**关键洞察**：`ast.type` 只告诉你大类（select/create/drop），细分要看 `ast.keyword`。

### Property-based testing 的不变量选择

好不变量：
- **任何字符串输入都不抛未捕获异常**（fail-secure 必须生效）
- **DROP DATABASE 所有变体必拒**（注释、大小写、Unicode 空白绕过都应被识别）
- **Allow 决策的 SQL 一定是有效 SQL**（不会允许解析失败）

坏不变量：
- "对所有合法 SQL 都返回 allow"——反向证伪难，AI 难生成

## 实施风险

| 风险 | 应对 |
|------|------|
| `node-sql-parser` 对 MySQL 8 个别语法支持不佳 | 加入 fixtures 后反复 fail-secure 时，考虑 PR 给 node-sql-parser 或降级为字符串 DDL 黑名单 |
| Property-based 暴露大量边缘 bug | 先记录到 issues，再分批修；优先修 crash 类，deny/allow 误判类其次 |
| `approved-task-override` 需要 DB 访问 | 通过 `ctx.db` 注入；测试用 in-memory mock |
| 规则链顺序依赖（如 approved-task-override 必须最先） | `RULES` 数组顺序即评估顺序，强制不可配置 |
