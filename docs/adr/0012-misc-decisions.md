# 0012: 杂项决策 —— 日志、i18n、License、并发、运维

**Status**: Accepted
**Date**: 2026-06-02

## Context

Q15 盲点扫描中确认的剩余 v1 决策，集中记录。

## Decision

### 日志：三层分离

| 关注点     | 存储                                                            | 写入方式             |
| ---------- | --------------------------------------------------------------- | -------------------- |
| 审计日志   | SQLite `audit_log` 表（[ADR-0004](./0004-audit-log-design.md)） | hash 链、append-only |
| 应用日志   | `~/.xizhao/logs/xizhao.log` + stderr                            | pino 结构化 JSON     |
| MCP 协议层 | 仅 stderr                                                       | MCP SDK 自身输出     |

**绝不混淆**。审计是产品功能，应用日志是开发辅助。

### pino 配置要点

- 双输出：file（永久，rotation 滚动）+ stderr（MCP 客户端可捕获）
- 不写 stdout（MCP 协议占用）
- 内置 `redact` 自动脱敏：`password` / `password_enc` / `apiKey` / `masterKey` / `Authorization` / `token` 字段一概 `[REDACTED]`
- rotation 用 `pino-roll`：每日 + 单文件 10MB 上限 + 总容量 100MB
- 默认 level `info`，`--verbose` 或 `XIZHAO_LOG_LEVEL=debug` 启用 debug
- AsyncLocalStorage 自动注入 `clientInfo`、`auditId`、`tool` 等字段

**SQL 全文默认入日志**（debug 排错需要），但提供 `XIZHAO_LOG_SQL=off` 环境变量关闭（仅记 SQL hash）。

### i18n：分层策略

| 层                               | 语言                          | 理由                                |
| -------------------------------- | ----------------------------- | ----------------------------------- |
| 错误信息（policy / mysql error） | **英文**                      | AI 训练语料英文多，识别错误模式更准 |
| CLI 交互提示                     | **中文**                      | 自用 + 10 人内部中文母语            |
| Dashboard UI                     | **中文**                      | 同上                                |
| 应用日志                         | **英文键 + 英文 value**       | grep 准确性                         |
| 代码注释                         | 中英混用                      | 与作者风格一致                      |
| ADRs                             | **中文**                      | 已成事实                            |
| README                           | **双语**：英文主 + 中文版链接 | portfolio 传播力                    |

v1 不引入 i18n 框架，UI 字符串硬编码中文。未来国际化时再抽 key。

### License：MIT

选用 MIT。简洁、业界认可度最高、对企业采纳无障碍。

### 连接池与并发

`mysql2` pool 配置：

```ts
{
  connectionLimit: 5,        // 单连接的 pool size
  queueLimit: 10,            // 排队上限
  waitForConnections: true,
  connectTimeout: 10_000,
}
```

单 Client 模式同时最多 5 个 in-flight 请求执行 SQL，超过排队。MCP 工具调用层面没有额外限流（依赖 pool 自身的队列）。

### 优雅关闭

SIGINT / SIGTERM 触发：

1. 拒绝新 MCP 请求（立即返回 `SERVER_SHUTTING_DOWN`）
2. 等待 in-flight 请求最长 5s
3. 关闭 MySQL 连接池
4. 关闭 SQLite 文件
5. 退出

Dashboard 单独处理：浏览器连接断开 → 5s 内自动退出。

### Schema 缓存（不做）

`list_tables` / `describe_table` 直接查 `information_schema`，v1 不缓存。dev/test 库 schema 变化频繁，缓存失效处理复杂。

### 配置导入导出（不做）

v1 不做 `xizhao export/import`。手动备份 `~/.xizhao/` 目录即可（含 master.key + config.db）。

### 更新机制（不做自动）

v1 手动更新。npm 用户 `npm update -g xizhao`，二进制用户重新下载 GitHub Releases。**不做**自动更新检查（隐私优先、纯本地工具哲学）。

### 发布渠道

- **npm**（主渠道）：`npm install -g xizhao` 或 `npx xizhao`
- **GitHub Releases**（二进制渠道）：单二进制，无需 Node
- **Homebrew tap**：v2 考虑

### 遥测（不做）

**绝不做**任何 phone-home、匿名使用统计。纯本地工具，隐私优先。

### 文档策略

- 单一 README（GitHub 主页就够），英文主、中文链接
- 详细设计在 `docs/adr/` 目录（已成体系）
- 不做 mkdocs / docusaurus 文档站

### Demo 数据（不做）

v1 不提供 `xizhao demo` 命令、不预置样本数据库。

**理由**：

- 犀照的价值在"AI 安全访问真实数据库"，demo 库失去真实性
- 用户都有 MySQL（dev/test 库场景），无需 Xizhao 提供
- 30 秒上手靠"配置自己已有的 MySQL"完成，而非"玩内置 demo"

### 端口与目录

- Dashboard 默认 `9020`，端口冲突时自动递增到 `9025`
- 跨平台目录解析用 [`env-paths`](https://www.npmjs.com/package/env-paths)
- Windows：`%USERPROFILE%\.xizhao\`
- macOS / Linux：`~/.xizhao/`

### 代码规范

- ESLint：`@antfu/eslint-config`（现代、opinionated、Vue/TS 友好）
- Prettier：默认配置
- Husky + lint-staged：pre-commit 自动 fix
- 提交前必跑：`lint` + `typecheck` + `test:unit`

## Consequences

**正面**：

- 日志三层分离让排错路径清晰，审计与应用诊断不互相污染。
- 错误信息英文化对 AI 友好，UI 中文化对人友好，README 双语对 portfolio 与中文受众兼顾。
- Apache 2.0 是企业级开源的标准选择。
- 不做遥测、不做 demo、不做配置导入导出 → v1 范围显著收缩。

**已接受的代价**：

- 单语言 UI（中文）意味着面向国际受众时需要再投入本地化工作。
- 不做配置导入导出，用户换机器时需要手动复制整个 `~/.xizhao/` 目录。
- 不做 demo 数据，没有 MySQL 的用户体验不到产品（但目标用户本来就有 MySQL）。

**未来重新审视的触发条件**：

- 出现国际用户 → 引入 i18n 框架
- 配置复杂化 → 做导入导出
- 用户量起来 → 评估 Homebrew / 自动更新
