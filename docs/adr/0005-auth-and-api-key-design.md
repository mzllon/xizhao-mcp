# 0005: 认证与 API Key 设计 —— 双轨认证、Key Hash 存储、Argon2id 密码

**Status**: Accepted
**Date**: 2026-06-02

## Context

犀照 Server 模式有两条认证通道：

1. **Web 面板**（浏览器）—— 同事登录、查看自己的 API Key 与审计、admin 配置连接与用户。
2. **MCP 工具调用**（Cursor / Claude Desktop / Claude Code 等客户端）—— 通过 HTTP 调用 MCP 接口。

两条通道的使用模式不同，应分别设计。

## Decision

### 双轨认证

| 通道 | 认证方式 | 理由 |
|------|--------|------|
| Web 面板 | 用户名 + 密码 → server-side session | 浏览器场景，密码自然；session 可即时吊销 |
| MCP 工具调用 | API Key（Bearer token） | 长期凭证、配在客户端配置、可独立吊销、无状态 |

不让 MCP 客户端用密码登录：避免在 MCP 协议上叠加 session 机制。
不让 Web 面板用 API Key 登录：浏览器场景输入 32 字符 key 体验差。

### API Key 设计

**格式**：`xz_<32 字符 base32>`，例如 `xz_AK7YHJQ2WN3XKM4PQR7SABCDE...`。

- `xz_` 前缀：肉眼可识别"这是犀照的 key"。误贴到 Slack / GitHub 时一眼能认出，立刻吊销。
- 32 字符 base32：约 160 bit 熵，防暴力，对人可读（4-4-4 分组显示）。

**存储**：**SHA256 hash**，原文只在创建时展示一次，从此消失。

```sql
CREATE TABLE api_keys (
  id           TEXT PRIMARY KEY,        -- ULID
  user_id      TEXT NOT NULL,
  name         TEXT,                    -- 用户起的名字，如 "Cursor-工作本"
  key_prefix   TEXT NOT NULL,           -- 前 8 位明文，UI 显示 "AK7YHJQ2..."
  key_hash     TEXT NOT NULL,           -- SHA256(原文)
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
);
```

**理由**：

- API Key 与密码不同——密码泄漏用户可改，API Key 配在客户端里，**用户根本不会知道**有人正在用它的 key 调 SQL（除非回头看审计日志）。所以必须假设泄漏后没人能第一时间发现。
- 行业标准：GitHub / Stripe / AWS / OpenAI / Anthropic 全部 hash 存储 API Key。这是"第一天就该有的设计"，不是规模到了才做。
- 实现成本：4 行代码（生成、hash、insert、查表比对）。

**生命周期**：

- 创建：用户在 Web 面板点"生成新 API Key" → 后端生成 → 明文展示一次 → 用户复制到 MCP 客户端配置 → 永不再展示。
- 使用：每次 MCP 调用带 `Authorization: Bearer xz_xxx` → 后端 `sha256(input)` 比对。
- 吊销：用户在 Web 面板点"吊销" → 设置 `revoked_at` → 后续调用立即失效。
- 每用户多 Key，不限制数量：鼓励用户给每个客户端配独立 key（"Cursor 工作本" / "Claude Desktop 家" / "GitHub Actions"），任一泄漏可单独吊销。
- 不过期：v1 不做自动过期，靠用户主动吊销。

**用户忘了 key**：吊销旧的 + 生成新的。这是 GitHub Personal Access Token 的标准模式。admin 不应该看到同事的 key（否则破坏审计"调用者=真正调用者"承诺）。

### 密码设计

**存储**：**Argon2id**（不是 bcrypt）。理由：

- 现代标准，抗 GPU/ASIC 攻击。
- Node 侧用 `@node-rs/argon2`，性能与原生接近。
- 参数：`memoryCost=19456 (19 MiB)`, `timeCost=2`, `parallelism=1`（OWASP 2023 推荐最低档）。

**首次登录强制改密**：admin 创建用户时设置临时密码 → 同事首次登录强制改密 → 临时密码不入审计明文（仅记录"密码重置事件"）。

### Session 设计

**服务器端 session**，存 SQLite，不用 JWT。

- Session ID：`crypto.randomBytes(32).toString('base64url')`，260 bit 熵。
- Cookie：`HttpOnly; Secure; SameSite=Strict; Path=/`。
- 默认 7 天过期，活跃续期（每次请求 reset TTL）。
- 吊销：直接删 SQLite session 表对应行。

**不用 JWT 的理由**：

- 单实例 Server，不需要分布式 session。
- JWT 吊销难，session 直接删行即可。
- 学习成本低。

### 初始 admin 引导

首次启动 Server：

1. 检测 `users` 表为空 → 进入引导模式。
2. Web 面板显示"创建第一个管理员账号"页面（用户名 + 密码）。
3. 创建后引导模式结束，正常登录流程生效。
4. 引导模式期间，MCP 工具调用一律拒绝（`SERVER_NOT_INITIALIZED`）。

### 角色权限

| 功能 | admin | user |
|------|-------|------|
| 调用 MCP 工具 | ✅ | ✅ |
| 查看自己的 API Key 列表 | ✅ | ✅ |
| 创建 / 吊销自己的 API Key | ✅ | ✅ |
| 查看自己的审计日志 | ✅ | ✅ |
| 查看所有人的审计日志 | ✅ | ❌ |
| 配置连接 | ✅ | ❌ |
| 创建 / 删除用户 | ✅ | ❌ |
| 清理审计日志 | ✅ | ❌ |

**user 能管自己的 key、看自己的审计** —— 避免小事都找 admin。

## Consequences

**正面**：

- API Key 数据库泄漏不能直接还原 key。
- Web 面板 session 可即时吊销（删除一行）。
- 角色权限极简（仅 2 档），但已足够覆盖 10 人团队场景。
- "Argon2id + API Key SHA256 hash + tamper-evident audit" 是作品集 README 上完整的安全叙事。

**已接受的代价**：

- API Key 不能"重新展示"——用户忘了只能吊销重生。这是有意为之。
- Session 是有状态的——Server 重启不丢失（存 SQLite），但水平扩展需要共享 session 存储（v2 问题）。
- 密码重置依赖 admin 介入——没有"忘记密码邮件"流程。10 人内部团队场景下，找 admin 重置比邮件流程更可靠。

**未来重新审视的触发条件**：

- 团队规模超 50 人 → 引入 RBAC 细分角色。
- 引入外部用户（如 PM 客户） → 重审 user 角色权限边界。
- Server 横向扩展 → session 改为 Redis / JWT。
