# Stage 01：工程骨架

> **输入：** 空 repo
> **输出：** 可构建、可测试、可 lint 的 TypeScript ESM 项目骨架
> **依赖：** 无
> **关联 ADR：** [0009](../adr/0009-dashboard-and-tech-stack.md)、[0011](../adr/0011-testing-strategy.md)、[0012](../adr/0012-misc-decisions.md)

## 目标

搭建项目基础设施。本阶段不写业务代码，但所有后续阶段都依赖这个骨架。

## 文件清单

- 创建：`package.json`
- 创建：`pnpm-workspace.yaml`（如果用 monorepo，否则跳过）
- 创建：`tsconfig.json`
- 创建：`tsup.config.ts`
- 创建：`vitest.config.ts`
- 创建：`eslint.config.mjs`
- 创建：`.prettierrc`
- 创建：`.husky/pre-commit`
- 创建：`.github/workflows/ci.yml`
- 创建：`.gitignore`（已存在，本阶段补全 Node 相关条目）
- 创建：`src/shared/errors.ts`
- 创建：`src/shared/ids.ts`（ULID 包装）
- 创建：`src/shared/time.ts`（ISO8601 工具）

## 详细步骤

- [ ] `pnpm init`，配置 ESM (`"type": "module"`)
- [ ] 配置 `tsconfig.json`：strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `verbatimModuleSyntax` + target `ES2022` + module `NodeNext`
- [ ] 配置 `tsup.config.ts`：entry `src/cli/index.ts`，format ESM，target node20，sourcemap
- [ ] 配置 `vitest.config.ts`：
  ```ts
  coverage: {
    provider: 'v8',
    reporter: ['text', 'html', 'lcov'],
    thresholds: {
      'src/core/policy/**': { lines: 95, functions: 95, branches: 90 },
      'src/core/crypto.ts': { lines: 95, functions: 95, branches: 90 },
      'src/core/audit.ts': { lines: 90, functions: 90, branches: 85 },
      'src/core/approval.ts': { lines: 90, functions: 90, branches: 85 },
      'src/core/connection.ts': { lines: 80, functions: 80, branches: 75 },
      'src/mcp/tools/**': { lines: 70, functions: 70, branches: 65 },
      'src/cli/**': { lines: 50, functions: 50, branches: 45 },
      'src/web/**': { lines: 50, functions: 50, branches: 45 },
    }
  }
  ```
- [ ] 配置 `eslint.config.mjs` 用 `@antfu/eslint-config`
- [ ] 在 `package.json` 加入脚本：
  ```json
  {
    "scripts": {
      "build": "tsup",
      "lint": "eslint .",
      "lint:fix": "eslint . --fix",
      "typecheck": "tsc --noEmit",
      "test": "vitest run tests/unit tests/mcp",
      "test:unit": "vitest run tests/unit",
      "test:integration": "vitest run tests/integration",
      "test:coverage": "vitest run --coverage",
      "test:property": "vitest run tests/unit/policy.property.test.ts",
      "prepare": "husky"
    }
  }
  ```
- [ ] 安装运行依赖：
  - `@modelcontextprotocol/sdk`
  - `zod`、`zod-to-json-schema`
  - `commander`、`@inquirer/prompts`、`chalk`、`ora`
  - `hono`
  - `node-sql-parser`
  - `mysql2`
  - `better-sqlite3`
  - `drizzle-orm`、`drizzle-kit`
  - `pino`、`pino-roll`、`pino-pretty`（dev only）
  - `env-paths`
  - `ulid`
- [ ] 安装开发依赖：
  - `typescript`
  - `tsup`
  - `vitest`、`@vitest/coverage-v8`
  - `@antfu/eslint-config`、`prettier`
  - `husky`、`lint-staged`
  - `testcontainers`、`@testcontainers/mysql`
  - `@fast-check/vitest`
  - `@types/better-sqlite3`、`@types/node`
- [ ] 配置 Husky：
  ```bash
  pnpm exec husky init
  echo "pnpm exec lint-staged" > .husky/pre-commit
  ```
- [ ] 配置 lint-staged：
  ```json
  {
    "*.{ts,tsx}": ["eslint --fix", "prettier --write"],
    "*.{json,md,yml}": ["prettier --write"]
  }
  ```
- [ ] 配置 CI（`.github/workflows/ci.yml`）：
  - matrix Node 20 / 22
  - 步骤：`pnpm install` → `lint` → `typecheck` → `test:unit` → `test:integration`（需要 Docker service）→ `build`
- [ ] 实现 `src/shared/errors.ts`：定义标准错误类 `XmSqlMcpError` + 错误码枚举（参考 ADR-0010）
- [ ] 实现 `src/shared/ids.ts`：`ulid()` 包装，便于 mock
- [ ] 实现 `src/shared/time.ts`：`nowIso()` 工具，便于 mock
- [ ] 创建空目录占位：`src/{cli,core,mcp,web}/`、`tests/{unit,integration,mcp,fixtures/sql}/`、`docs/plan/`（已有）

## 验收

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test:unit      # 应该 0 测试通过
pnpm build
ls dist/cli/index.js   # 应该存在
```

## 关键技术点

### 依赖选型理由

- **tsup 而非 esbuild 直接**：tsup 自带 TypeScript 类型生成 + 更好的 CLI 默认配置
- **pino 而非 winston**：性能高 5-10 倍，结构化 JSON 输出原生支持
- **better-sqlite3 而非 sqlite3**：同步 API 更简单、性能更好
- **@antfu/eslint-config 而非默认**：现代、opinionated、TS strict 兼容好

### ESM 注意事项

- 所有相对 import 必须带 `.js` 后缀（即使源码是 `.ts`）
- `tsconfig.json` 中 `"moduleResolution": "NodeNext"` + `"verbatimModuleSyntax": true`
- 如果遇到 CJS-only 包，用动态 `await import('cjs-pkg')`

## 实施风险

| 风险                                    | 应对                                                      |
| --------------------------------------- | --------------------------------------------------------- |
| `@antfu/eslint-config` 与项目风格冲突   | 阶段一结束时检查 eslint warnings，必要时覆盖个别规则      |
| better-sqlite3 在某些 Node 版本编译失败 | 锁定 better-sqlite3 ^11，Node 20+ 应该有 prebuilt binary  |
| Husky 在 Windows 上不工作               | 验证 `pnpm exec husky init` 在 Windows 上能创建 `.husky/` |
