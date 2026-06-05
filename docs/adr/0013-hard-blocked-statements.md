# 0013: 执行层硬拦截 —— CREATE/DROP/ALTER DATABASE 永久禁止

**Status**: Accepted
**Date**: 2026-06-03
**Supersedes**: —
**Related**: ADR-0002（策略引擎）、ADR-0008（审批工作流）

## Context

Stage 04 策略引擎在 AST 层拦截危险 SQL（包括 `create_database`、`drop_database`）。但这只是**单层防御**——如果策略引擎被绕过（代码 bug、配置错误、直接调用 `executeSql`），危险语句仍会到达 MySQL。

`CREATE DATABASE` / `DROP DATABASE` / `ALTER DATABASE` 影响整个 MySQL 实例，不仅仅是单个连接的 scope。对 dev/test 场景，这类操作的风险远大于收益——AI 代理永远不应该创建或删除数据库。

## Decision

在 `src/core/mysql.ts`（执行层）加入**硬拦截**，与策略引擎独立：

- `CREATE DATABASE` / `CREATE SCHEMA` → 永久阻止
- `DROP DATABASE` / `DROP SCHEMA` → 永久阻止
- `ALTER DATABASE` → 永久阻止

实现方式：正则匹配 SQL 文本，命中即抛 `XmSqlMcpError('POLICY_VIOLATION')`，**不经过策略引擎**。

### 两层防御模型

| 层               | 位置                           | 拦截方式          | 可配置性               |
| ---------------- | ------------------------------ | ----------------- | ---------------------- |
| **策略引擎**     | MCP tool handler → `policy/`   | AST 解析 + 规则链 | 可通过 policy 配置     |
| **执行层硬拦截** | `mysql.ts` → `assertSqlSafe()` | 正则匹配          | **不可配置，不可绕过** |

策略引擎处理细粒度策略（如"DDL 需审批"、"强制 LIMIT"），执行层硬拦截处理"绝对禁止"的操作。

## Consequences

**正面：**

- 纵深防御：即使策略引擎被绕过，数据库级操作也无法执行
- 零配置：不需要用户手动启用，代码内置
- 安全基线：产品承诺"AI 永远不会创建或删除数据库"

**已接受的代价：**

- 正则匹配可能有边缘情况（如注释内的语句）。但 `CREATE DATABASE` 在任何上下文下都不应被需要，误报可接受。
- 如果未来需要支持 CREATE DATABASE（如自动化部署场景），需要修改源码。这是**有意的**——这种操作不应该轻易开放。

**不拦截的操作（由策略引擎控制）：**

- `CREATE TABLE` / `DROP TABLE` / `ALTER TABLE` → 策略引擎控制（需审批）
- `TRUNCATE` → 策略引擎控制（blocked）
- `GRANT` / `REVOKE` → 策略引擎控制（blocked）
- `INSERT` / `UPDATE` / `DELETE` → 策略引擎控制（allow）
