# 0004: 审计日志设计 —— 字段结构、Hash 链防篡改、Append-Only

**Status**: Accepted
**Date**: 2026-06-02

## Context

审计日志是犀照 v1 的第二大叙事（仅次于策略引擎），也是 admin 在 Web 面板上唯一会真正使用的功能。它需要满足：

1. **完备**：每条 MCP 工具调用必产生一条记录，无论成功失败。
2. **可信**：即使管理员（admin）本人也不能悄悄改/删日志栽赃给同事。
3. **简单**：10 人内部团队，不需要复杂查询、报表、告警。

## Decision

### 字段结构

每条审计记录包含：
- 调用者身份（user_id、API Key 后 4 位、IP、MCP 客户端 `clientInfo.name`）
- 目标（connection 别名）
- 请求（tool 名、原始 SQL 全文）
- 策略引擎判定（decision: `allow | deny | parse_error`、rule 名、reason、耗时）
- 执行结果（status、MySQL 错误码、affected/rowCount、truncated、耗时）—— 仅 policy allow 时存在

不存查询结果本身（体积大、AI 已经看到、无审计价值）。

存原始 SQL 全文（dev/test 场景 SQL 不会过大，且这是审计核心价值）。

### 写入策略：fail-on-audit-failure

审计写入作为 MCP 工具返回前的最后一步，**同步写入 SQLite**。如果审计写失败，工具返回 `INTERNAL_ERROR`。

理由：审计是产品承诺的核心，"尽力写、写失败只 warn" 一旦出 bug 会丢日志，破坏治理叙事。

### 防篡改：Hash 链

每条日志包含：
- `prevHash`：上一条日志的 hash
- `payload`：本条日志的全部字段（含 prevHash）
- `hash`：`sha256(payload)`

形成单向链。

**防御范围**：
- 管理员用 SQLite 工具直接改一条记录 → 后续所有 hash 校验失败
- 管理员删一条记录 → 链断裂
- 管理员在中间插一条假记录 → 后续 hash 对不上

**不防御**：
- 管理员重写整个日志文件（从创世重新算所有 hash）。v1 接受这个风险，10 人内部团队场景下威胁模型不包含"管理员从头伪造整个审计"。

**不做外部 anchor**（如每日邮件 root hash）：复杂度收益比不划算。Hash 链已经把"信任 admin"降级为"信任 admin 不会重写整个数据库"，对当前场景足够。

### 保留期限

- **不主动清理**。dev/test 库一年撑死几十万条记录，SQLite 单文件轻松承载。
- Web 面板提供"清理 N 天前日志"按钮，由 admin 主动操作。
- **禁止代码层面的自动过期**——违反 append-only 承诺。

## Consequences

**正面**：

- 审计设计极简：一张表、append-only、hash 链。总代码量约 100 行。
- "Tamper-evident audit log via hash chaining" 是 README 上的清晰技术叙事。
- admin 自身也受日志约束，避免"管理员背锅"或"管理员栽赃"的信任困境。

**已接受的代价**：

- Hash 链使批量插入必须串行（每条依赖前一条 hash）。MCP 场景下 QPS 不高，可接受。如果未来需要高并发，可改为"每秒一个 batch，batch 内并行 + batch 间串行"。
- 不防御管理员重写整个日志。这是显式接受的威胁模型缺口。
- SQLite 单文件损坏会丢失全部审计。**建议但不在 v1 范围**：每日 cron 备份到第二个位置。

**反例（不适用本设计）**：

- 真 SaaS 场景：需要外部 anchor + Merkle 树 + 跨租户隔离审计。v1 不考虑。
- 跨年合规场景：需要不可删除策略（如保留 7 年）+ 数字签名时间戳。v1 不考虑。
