# 0002: SQL 策略引擎基于 AST + MySQL 权限双层防御

**Status**: Accepted
**Date**: 2026-06-02

## Context

策略引擎是XM的核心防线，决定每条 AI 生成的 SQL 能否执行。PRD 列出 5 条策略需求（S-01 ~ S-05），实现路线有三：

1. **字符串 / 正则黑名单**：实现简单但可被注释、大小写、Unicode 空白、动态 SQL 等手法 5 秒绕过，等同 security theater。
2. **SQL AST 解析**：用真正的 SQL parser 把 SQL 解析成语法树，基于语法树判定。
3. **MySQL 自身权限**：依赖 MySQL `GRANT` / `READ_ONLY` 做硬约束，应用层不做策略。

XM定位为部门级内部工具 + 开源作品集（见 [ADR-0001](./0001-non-commercial-positioning.md)）。策略引擎是作品集的技术叙事核心，必须在 README 上能堂堂正正写"AST-based, not string matching"。

## Decision

采用 **AST 解析（路线 B）+ MySQL 最小权限（路线 C）双层防御**。

### 应用层（AST）

- 依赖：[`node-sql-parser`](https://www.npmjs.com/package/node-sql-parser)，选型理由：MySQL 支持最成熟、Star 最多、文档最全、社区活跃。
- 每个 SQL 请求经过：`parse(sql) → AST → 规则链评估 → Allow | Deny(reason, rule)`。
- 一条规则 = 一个独立模块，注册到规则数组。规则链短路：任一规则 Deny 即立即返回。
- AST 解析失败时 **fail-secure**（拒绝执行 + 错误日志记录原始 SQL）。理由：MCP 场景下 AI 收到错误会自我修正，比悄悄放过更可控；极端 SQL（存储过程 / 动态 SQL）本就不应出现在 dev/test 库场景。

### 数据库层（MySQL GRANT）

- 每个连接配置对应的 MySQL 账号必须持有**最小权限**。例如 dev 连接只授 `dev_*` schema 的 `SELECT/INSERT/UPDATE/DELETE`，test 连接可以更宽松但不给 `DROP` / `GRANT` / `SUPER`。
- 配置连接时 Web 面板展示"建议权限清单"，引导管理员按最小权限原则设置。
- 应用层拒绝 + DB 层拒绝都会被审计日志记录，但区分来源（`policy` vs `mysql`）。

## Consequences

**AST 路径覆盖的 PRD 需求**（一锅端）：

| 编号 | 需求         | AST 实现方式                                       |
| ---- | ------------ | -------------------------------------------------- |
| S-01 | 关键字黑名单 | 检查 `statement.type` 是否在禁用列表               |
| S-02 | 操作类型控制 | 检查 `statement.type` 是否在该连接允许的类型集合内 |
| S-03 | 强制 LIMIT   | 检查 `statement.limit` 是否存在且 ≤ 上限           |
| S-04 | 表级权限     | 检查 `statement.tables` 是否都在白名单内           |
| S-05 | 连接级只读   | 等价于 S-02 只允许 `select`                        |

**架构简洁性**：所有策略收敛到一个判定函数 `evaluate(sql, ctx) → Decision`，无并发分支，无副作用，易于测试。

**新增策略的成本**：写一个新的 `PolicyRule` 模块、注册到规则数组、写单元测试。约 30-100 行代码。

**已接受的代价**：

- 单次 AST parse 约 0.5-2ms，对 MCP 场景可忽略（远小于 SQL 执行本身）。
- `node-sql-parser` 对 MySQL 8 个别新语法（如窗口函数嵌套）解析不稳定 → 这种情况走 fail-secure 分支，由 AI 自我修正。
- 双层防御意味着同一个 SQL 可能在两处都失败。错误信息需明确区分是哪一层拒绝，便于调试。

**未来重新审视的触发条件**:

- 接入 PostgreSQL（D-04）：`node-sql-parser` 同样支持，但需测试覆盖。
- 引入审批流（v2）：策略引擎需要新增返回值 `{ kind: 'need_approval' }`，规则链接口已为此预留。
