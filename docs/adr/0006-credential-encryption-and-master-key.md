# 0006: MySQL 凭证加密与主密钥管理

**Status**: Accepted
**Date**: 2026-06-02

## Context

连接配置中的 MySQL 密码必须保护——SQLite 文件单独泄漏不应直接暴露所有 MySQL 凭证。但与 API Key 不同，MySQL 密码**必须可还原**（Xizhao 需要拿明文去连 MySQL），所以不能用单向 hash，必须用**对称加密 + 主密钥**方案。

## Decision

### 主密钥来源：独立文件

首次启动时自动生成 32 字节随机主密钥，写入 `~/.xizhao/master.key`（或环境变量 `XIZHAO_MASTER_KEY_FILE` 指定的位置），权限 `0600`。

- SQLite 文件单独泄漏 → 无法解密密码。
- master.key 单独泄漏 → 无法解密密码（没有密文）。
- **两者同时泄漏 → 密码暴露**。这是显式接受的威胁模型。

**不选环境变量**作为唯一来源：环境变量在 ps、proc、容器 inspect 中可见，且重启后需要重新注入，运维门槛高。但保留 `XIZHAO_MASTER_KEY_FILE` 环境变量作为企业部署的扩展位。

**不选密码派生**（如 PBKDF2 from admin password）：会导致 admin 改密时所有连接需重新加密，且 Server 重启需 admin 输密码解锁，破坏无人值守运维。

### 加密算法：AES-256-GCM

Node 内置 `node:crypto`，无第三方依赖。

- 每条记录独立 12 字节 IV（随机生成），永不复用。
- 16 字节认证标签（auth tag）防篡改。
- 存储格式：`base64(iv || tag || ciphertext)` 单字段。

### 表结构

```sql
CREATE TABLE connections (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  host            TEXT NOT NULL,
  port            INTEGER NOT NULL DEFAULT 3306,
  username        TEXT NOT NULL,
  password_enc    TEXT NOT NULL,            -- AES-256-GCM 加密后 base64
  default_schema  TEXT,
  policy          TEXT NOT NULL,            -- JSON
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  last_used_at    TEXT
);
```

`policy` 用 JSON 字段（SQLite 原生支持 JSON）：10 人团队场景下，每条连接策略差异小，结构化列过度设计。JSON 灵活、易扩展。

### 主密钥备份与灾难恢复

**首次生成时强制提示**：

```
⚠️  Generated master key at /home/you/.xizhao/master.key
⚠️  Back this file up somewhere safe.
⚠️  If lost, ALL stored MySQL passwords become unrecoverable.
```

**Web 面板首页显示"主密钥健康"卡片**：密钥指纹（hash 前 8 位）、上次备份提醒、最后修改时间。

**不实现**：

- 自动云备份（内部团队，复杂度收益不划算）
- 主密钥轮换（v2 工作，但接口 `rotateMasterKey()` 签名先定义）

## Consequences

**正面**：

- 一套代码同时支持个人部署（文件 master key）和企业部署（环境变量指向 K8s Secret）。
- 主密钥与密文物理分离，威胁模型清晰。
- "AES-256-GCM + per-record IV + 分离主密钥 + 灾难恢复提示" 是完整的密码学叙事，作品集 README 有内容。

**已接受的代价**：

- master.key 文件丢失 → 所有连接密码永久不可恢复。这是对称加密的固有代价，无法绕过。
- 主密钥不轮换（v1）→ 长期泄漏风险存在但概率低。
- 没有自动云备份 → 依赖 admin 手动备份。Web 面板会提醒，但不强制。

**未来重新审视的触发条件**：

- 团队规模超 50 人 / 接入生产库 → 实现主密钥轮换 + 自动备份到第二个位置。
- 部署到 Kubernetes → 切换到环境变量模式 + KMS。
