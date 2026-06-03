# 0003: "Authoritative Source" 原则 —— 不重写数据库的权威表述

**Status**: Accepted
**Date**: 2026-06-02

## Context

在设计 MCP 工具的返回格式时，遇到一个反复出现的取舍：当数据库本身能给出某个信息的权威表述（如 `SHOW CREATE TABLE`、`EXPLAIN FORMAT=JSON`），Xizhao 应该 (a) 直接转发，还是 (b) 解析后用自定义结构化字段重新表达？

例：`describe_table` 可以返回原始 DDL 字符串，也可以返回 `{ columns: [...], indexes: [...], primaryKey: [...] }` 的结构化字段。

## Decision

**直接转发数据库的权威表述，不做结构化重写。**

适用场景：

| 工具 | 权威表述 | 不重写 |
|------|--------|--------|
| `describe_table` | `SHOW CREATE TABLE` 的 DDL | 不抽 columns / indexes / primaryKey |
| `explain_sql` | `EXPLAIN FORMAT=JSON` | 不抽 type / key / rows 字段 |
| 未来 `show_variables` | `SHOW VARIABLES` 输出 | 不重映射 |
| 未来 `list_databases` | `SHOW DATABASES` | 不包装 |

**Xizhao 的角色是策略与审计，不是数据库语义翻译。**

## Rationale

1. **信息完备性**：DDL / EXPLAIN JSON 是 ground truth，自定义结构化几乎必然会丢信息（comments、generated columns、invisible columns、check constraints、partitions、charset 等）。
2. **AI 是消费者**：AI 训练语料包含海量 DDL / EXPLAIN，原生能解析这些格式，不需要"对人类友好"的中间层。
3. **零维护成本**：MySQL 升级新特性（如 MySQL 9 的 VECTOR 类型）时，Xizhao 不需要改任何代码。
4. **一致性**：策略引擎读 AST（也是权威），工具输出读 DDL/EXPLAIN（也是权威），全栈统一。
5. **结构化唯一的弱价值是"跨数据库统一"**——但 v1 只支持 MySQL，且 AI 同样能读 PostgreSQL 的 DDL。

## Consequences

**正面**：

- `describe_table` / `explain_sql` 等工具的代码极简：一个查询 + 直接返回。
- 工具输出对 MySQL 新特性前向兼容。
- README 可写"零中间层，AI 直接读数据库权威表述"。

**已接受的代价**：

- 输出体积比结构化大（DDL 包含多余空格、约束子句等）。对 MCP 场景可忽略。
- 如果未来想做"对人类友好的 Web 面板查看表结构"，需要在 Web 层重新解析 DDL。这是 Web 层的职责，不应污染 MCP 协议层。
- 跨数据库迁移时，AI 要适应不同方言的 DDL/EXPLAIN，而不是享受 Xizhao 提供的"统一抽象"。这是有意为之——抽象层会损失信息。

**反例（不适用本原则的场景）**：

- `list_tables`：返回 `{ name, type }[]` 而不是 `SHOW TABLES` 的纯文本。理由：`SHOW TABLES` 输出格式简陋（无 type 列），不是"权威表述"，只是简化的展示。Xizhao 这里的组合（合并 `information_schema.tables`）是**增值**而非**重写**。
- `execute_sql` 的 SELECT 结果：返回 `{ columns, rows }` 而不是原始 MySQL 文本协议。理由：mysql2 driver 已经做了协议层解析，那是 driver 的职责，不算重写。

**未来重新审视的触发条件**:

- 出现明确的"AI 读不懂原始格式"反馈（目前不存在）。
- 引入 Web 面板，需要为面板单独做结构化解析时——在 Web 层做，不污染 MCP。
