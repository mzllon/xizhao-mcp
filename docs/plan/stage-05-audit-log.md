# Stage 05：审计日志与应用日志

> **输入：** Stage 02 存储 + Stage 04 策略引擎
> **输出：** hash 链审计日志 + pino 三层日志 + redact
> **依赖：** Stage 02、Stage 04
> **关联 ADR：** [0004](../adr/0004-audit-log-design.md)、[0012](../adr/0012-misc-decisions.md)

## 目标

实现"治理平台"叙事的核心——审计日志。每条 MCP 工具调用必产生一条记录，append-only + hash 链防篡改。同时实现应用日志基础设施。

## 文件清单

- 创建：`src/core/audit.ts`
- 创建：`src/core/logger.ts`
- 创建：`src/shared/redact.ts`
- 创建：`tests/unit/core/audit.test.ts`
- 创建：`tests/unit/core/logger.test.ts`
- 创建：`tests/unit/core/redact.test.ts`

## 详细步骤

### 5.1 审计日志写入

- [ ] `src/core/audit.ts` 实现 `appendAuditLog(event)`：
  - **同步写入** SQLite（用 better-sqlite3 同步 API）
  - 字段（参考 ADR-0004）：
    - `id`：ULID
    - `timestamp`：ISO8601 UTC
    - `tool`：'execute_sql' / 'explain_sql' / ...
    - `caller_user_id`：'local'（Client 模式）
    - `caller_api_key_id`：null（Client 模式）
    - `caller_ip`：null（Client 模式）
    - `mcp_client_id`：从 AsyncLocalStorage 取（如 'claude-code'）
    - `connection_name`：连接别名
    - `sql`：原始 SQL 全文
    - `policy_decision`：'allow' / 'deny' / 'parse_error'
    - `policy_rule` / `policy_reason` / `policy_duration_ms`
    - `exec_status`：'success' / 'mysql_error' / 'timeout' / null
    - `exec_mysql_error_code` / `exec_affected_rows` / `exec_row_count` / `exec_truncated` / `exec_duration_ms`
  - **事务性写入**：在 SQLite `BEGIN IMMEDIATE` 事务内插入 + 更新 hash 链

### 5.2 Hash 链

- [ ] 在 `appendAuditLog` 内：
  1. 查最后一条 `hash`（`SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1`）
  2. payload = `JSON.stringify({ ...event, prevHash })`
  3. `hash = sha256(payload)` hex
  4. 插入完整记录
- [ ] 实现 `verifyAuditChain() -> { valid; brokenAt? }`：
  - 扫描所有记录、重算 hash、比对
  - 检查 prev_hash 链接

### 5.3 Fail-on-audit-failure

- [ ] `appendAuditLog` 失败 → 抛 `XmSqlMcpError('AUDIT_WRITE_FAILED')`
- [ ] 上层 MCP middleware 捕获后返回 `INTERNAL_ERROR`
- [ ] **绝不**返回 SQL 执行结果而审计写入失败

### 5.4 Pino 配置

- [ ] `src/core/logger.ts` 用 pino + pino-roll + multistream：
  - 双输出：file（rotation daily + 10MB + 100MB 总）+ stderr
  - 内置 redact（路径来自 `shared/redact.ts`）
  - 默认 level `info`，`--verbose` 或 `XM_SQL_MCP_LOG_LEVEL=debug` 启用 debug
  - 自动注入 `auditId` / `clientInfo`（从 AsyncLocalStorage 取）

### 5.5 Redact 路径

- [ ] `src/shared/redact.ts`：
  ```ts
  export const redactPaths = [
    "password",
    "password_enc",
    "*password*",
    "*Password*",
    "apiKey",
    "*api_key",
    "*ApiKey",
    "masterKey",
    "master_key",
    "req.headers.authorization",
    "req.headers.Authorization",
    "sql.params.*",
    "token",
    "*_token",
    "*Token",
  ];
  ```

### 5.6 测试

- [ ] **审计测试**：
  - 写入 → 字段正确
  - 连续 100 条 → hash 链完整
  - 修改一条 sql → `verifyAuditChain()` 返回 broken
  - 删除中间一条 → 返回 broken
  - 中间插入伪造 → 返回 broken
  - `appendAuditLog` 失败（mock db 抛错）→ 抛 `AUDIT_WRITE_FAILED`
- [ ] **logger 测试**：
  - redact 生效
  - stderr 与 file 都有输出
  - rotation 触发
  - **stdout 没有任何输出**
- [ ] **redact 测试**：嵌套对象 / 数组 / 大小写变体

## 验收

```bash
pnpm test:unit tests/unit/core/audit.test.ts tests/unit/core/logger.test.ts tests/unit/core/redact.test.ts
pnpm test:coverage -- src/core/audit.ts src/core/logger.ts src/shared/redact.ts
```

预期：

- 所有测试通过
- `src/core/audit.ts` 覆盖率 ≥ 90%
- `src/core/logger.ts` 覆盖率 ≥ 80%

## 关键技术点

### Hash 链的串行写入

- 用 `BEGIN IMMEDIATE` 事务串行化写入
- 多个并发请求会排队，hash 链不会乱
- WAL 模式下 reader 不阻塞

### Pino redact 的隐藏行为

- redact 只作用于对象字段，纯字符串 msg 不脱敏
- 实现 logger 时统一用 `logger.info({ data }, msg)` 格式

## 实施风险

| 风险                            | 应对                                                   |
| ------------------------------- | ------------------------------------------------------ |
| Hash 链"重写整个日志"攻击       | v1 接受（ADR-0004）；v2 考虑外部 anchor                |
| SQLite 写满磁盘                 | Dashboard 概览页显示剩余空间告警                       |
| AsyncLocalStorage 跨 await 丢失 | 用 `AsyncLocalStorage.bind()` 或所有 await 在 run() 内 |
