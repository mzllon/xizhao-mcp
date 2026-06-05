# 0011: 测试策略 —— 单元 + 集成 + Property-based

**Status**: Accepted
**Date**: 2026-06-02

## Context

测试是作品集"工程素养"的核心证据。v1 的安全核心（策略引擎、加密、审计 hash 链）必须高覆盖。但 v1 是单人开发的非商业项目，不能花太多时间在测试基础设施上。

## Decision

### 测试金字塔

| 层级         | 范围                                | 工具                    | v1 状态   |
| ------------ | ----------------------------------- | ----------------------- | --------- |
| 单元测试     | `core/*` 纯函数                     | Vitest                  | ✅ 必做   |
| 集成测试     | `core/*` + 真 SQLite + 真 MySQL     | Vitest + testcontainers | ✅ 必做   |
| MCP 协议测试 | MCP 客户端模拟 + XM-SQL-MCP + MySQL | Vitest + MCP SDK Client | 🟡 部分做 |
| E2E 测试     | Claude Code 真实跑                  | 手动                    | ❌ 不做   |

E2E 不做：LLM 行为不可控，自动化不可靠。手动测试 + 录屏演示。

### 策略引擎测试语料库

建 `tests/fixtures/sql/` 目录，分类存 SQL 样本：

```
tests/fixtures/sql/
├── select/
├── insert/
├── update/
├── delete/
├── ddl/
├── dangerous/
│   ├── multi-statement.sql
│   ├── comment-bypass.sql
│   ├── case-bypass.sql
│   ├── unicode-whitespace.sql
│   └── dynamic-sql.sql
└── utility/
```

每个 SQL 文件对应一个 JSON 描述预期 AST 类型 + 预期 policy 决策。用 fixtures-driven 测试：

```ts
describe.each(loadFixtures("tests/fixtures/sql/dangerous/"))(
  "Dangerous SQL: $name",
  ({ sql, expectedDecision }) => {
    test("denied", () => {
      const result = evaluate(sql, mockContext);
      expect(result.kind).toBe("deny");
    });
  },
);
```

这是作品集亮点：**SQL 安全测试语料库，覆盖已知所有绕过手法**。

### 集成测试：testcontainers 跑真 MySQL

不 mock MySQL。用 [`testcontainers-node`](https://node.testcontainers.org/) 拉真实 MySQL Docker 容器。

```ts
import { MySqlContainer } from "@testcontainers/mysql";

describe("execute_sql integration", () => {
  let container;
  beforeAll(async () => {
    container = await new MySqlContainer("mysql:8").start();
  });
  afterAll(async () => container?.stop());
  // ...
});
```

CI（GitHub Actions）需要 Docker-in-Service 配置。

### Property-based testing：基础版

用 [`@fast-check/vitest`](https://github.com/dubzzz/fast-check) 验证策略引擎鲁棒性。

不变量（v1 范围）：

1. 任意输入 SQL（包括随机字符串），策略引擎**不抛未捕获异常**（fail-secure 必须生效）
2. 所有 DROP DATABASE 已知变体（注释/大小写/Unicode 空白）必拒

```ts
fcTest.prop({ sql: fc.string() })(
  "policy engine never crashes on any string input",
  ({ sql }) => {
    expect(() => evaluate(sql, mockContext)).not.toThrow();
  },
);
```

不做：复杂 SQL arbitrary 生成（成本高）、AST 反向生成（成本高）。

### CI：GitHub Actions

```yaml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [20, 22]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
      - uses: actions/setup-node@v4
        with: { node-version: ${{ matrix.node-version }}, cache: pnpm }
      - run: pnpm install
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test:unit
      - run: pnpm test:integration
  build:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - run: pnpm build    # 验证打包
```

矩阵只测 Node 20 / 22（LTS 与 latest）。

### 覆盖率目标

| 模块                 | 目标                   |
| -------------------- | ---------------------- |
| `core/policy.ts`     | **95%+**（安全核心）   |
| `core/crypto.ts`     | **95%+**（密码学核心） |
| `core/audit.ts`      | 90%+                   |
| `core/approval.ts`   | 90%+                   |
| `core/connection.ts` | 80%+                   |
| `mcp/tools/*`        | 70%+                   |
| `cli/commands/*`     | 50%+                   |
| `web/*`              | 50%+                   |

Vitest `coverageThreshold` 强制。低于阈值的 PR 不能合并（虽然单人开发，但写进配置防自己放松）。

### 测试命令

```
pnpm test                    # 默认跑单元 + property
pnpm test:unit               # 只单元
pnpm test:integration        # 集成（需 Docker）
pnpm test:watch              # watch
pnpm test:coverage           # 覆盖率
pnpm test:property           # 仅 property（慢）
pnpm lint                    # ESLint
pnpm typecheck               # tsc --noEmit
```

## Consequences

**正面**：

- 策略引擎覆盖率 95%+ 是作品集 README 上的硬指标。
- SQL 安全测试语料库可在博客单独写一篇，HN 上有传播潜力。
- testcontainers 集成测试保证 `execute_sql` 与 MySQL 真实交互正确。
- CI 矩阵覆盖 Node 20/22，未来 LTS 切换无痛。

**已接受的代价**：

- 集成测试需要 Docker，本地无 Docker 时反馈循环差。建议本地装 Docker Desktop。
- E2E 不做意味着某些 MCP 客户端兼容性问题在 CI 不可见，依赖手动测试发现。
- Property-based 基础版可能漏掉某些 SQL 边界情况，但成本与收益权衡可接受。

**未来重新审视的触发条件**：

- 用户报告"AI 写的某种 SQL 触发了未预期行为" → 扩展测试语料库
- 出现偶发 MySQL 兼容问题 → 增加多版本 MySQL 矩阵（8.0 / 8.4 / 9.x）
- 团队规模扩大 → 引入预合并必跑 + CODEOWNERS
