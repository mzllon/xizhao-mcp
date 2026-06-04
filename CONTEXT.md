# Xizhao (犀照)

为 AI 代理访问 MySQL 提供安全代理与全量审计的 MCP (Model Context Protocol) 服务器。**v1 第一发布是 Client 模式（开发者本机单用户）**，Server 模式（小团队多用户）作为 v2 紧随其后。仅访问 dev / test 库，不做生产库、不做 SaaS、不做多租户。

## 命名典故

**"犀照"** 取自南朝刘敬叔《异苑》"犀角烛怪"典故：晋代温峤燃犀牛角，照见水下精怪无所遁形。

- **寓意**：AI 生成的 SQL 中可能藏着"妖怪"（危险模式、未授权操作、SQL 注入等），犀照用 AST 解析 + 策略引擎把它们一一照出。
- **双关**："犀"既指灵犀（AI 与数据库心灵相通），又指犀角（识别妖物的工具）。"照"即审计、明察。
- **Slogan**：_犀照 SQL，众妖毕现。_

CLI 命令、配置目录、API Key 前缀、环境变量前缀：

| 项           | 值                                                            |
| ------------ | ------------------------------------------------------------- |
| CLI 命令     | `xizhao`                                                      |
| 配置目录     | `~/.xizhao/`                                                  |
| API Key 前缀 | `xz_`（参考 GitHub `ghp_`、Stripe `sk_` 的 3 字符惯例）       |
| 环境变量前缀 | `XIZHAO_*`（如 `XIZHAO_LOG_LEVEL`、`XIZHAO_MASTER_KEY_FILE`） |

## 部署形态

**Client 模式 (Client Mode)**:
**v1 主形态**。单用户、本地运行、通过标准输入输出 (Stdio) 与 MCP 客户端（Claude Code / Codex / Cursor）通信的二进制进程。MCP 通道无 HTTP、无认证、无多用户；Dashboard 作为独立命令按需启动，使用本地 HTTP + token 认证。
_Avoid_: 本地模式、单机模式

**Server 模式 (Server Mode)**:
**v2 形态**。常驻服务器进程、通过 Streamable HTTP 暴露 MCP 接口、支持多用户认证与集中审计。部署在公司内网单台服务器上，约 10 人级别团队共用。
_Avoid_: 服务端、企业模式、多用户模式

**自身存储 (Self Storage)**:
Xizhao 自己用来保存连接配置、审计日志、审批任务等的存储。默认 SQLite 单文件。与"目标数据库"严格区分。
_Avoid_: 元数据库、配置库、内部库

**目标数据库 (Target Database)**:
被 Xizhao 代理访问的 MySQL 实例（dev 或 test 库）。一条 SQL 从 MCP 客户端发出，经过 Xizhao，最终在目标数据库上执行。
_Avoid_: 业务库、源库

## 核心概念

**连接 (Connection)**:
一组目标数据库访问配置的命名别名，包含：主机、端口、用户、密码（加密存储）、默认库、安全策略、描述。通过别名引用，不直接接触凭证。AI 通过 `list_connections` 工具发现可用连接名，再用别名调用其他工具。
_Avoid_: 数据源、DataSource、DB instance

**连接描述 (Connection Description)**:
创建连接时由开发者填写的一段自由文本，说明该连接的用途和适用项目（如 `"项目 A 开发库，schema: app_a"`）。`list_connections` 会原样返回给 AI，帮助 AI 在多个连接中准确选择，而不是猜测。也可作为 CLI `--default-connection` 的辅助说明。
_Avoid_: 连接备注、连接注释

**项目级默认值 (Project Defaults)**:
一个项目希望 AI 默认使用的连接名和 schema。通过三种机制叠加实现（优先级从高到低）：① CLI 参数 `--default-connection` / `--default-schema`（项目级 MCP 配置时由客户端传参）；② `list_connections` 返回的连接描述（AI 侧自行判断）；③ 项目指令文件（CLAUDE.md 等，软约束兜底）。不依赖服务端感知项目目录。
_Avoid_: 项目配置、workspace 配置

**策略引擎 (Policy Engine)**:
MCP 工具执行前必须通过的检查层。输入：原始 SQL + 调用者 + 连接配置。输出：`allow` / `deny` / `need_approval`（最后一种触发审批任务）。是产品最核心的防线。
_Avoid_: 安全过滤器、SQL 检查器

**审批任务 (Approval Task)**:
策略引擎返回 `need_approval` 时创建的待审记录。包含 SQL、触发规则、状态（pending / approved / denied / expired / consumed）、决定人等信息。v1 是 self-approve（开发者审批自己 AI 的请求）；v2 升级为 role-approve（多人审批）。
_Avoid_: 工单、ticket、approval request

**审计日志 (Audit Log)**:
追加写入 (append-only) 的操作记录，每条 MCP 工具调用产生一条。包含：时间、调用者、连接名、原始 SQL、策略引擎判定、执行结果摘要、耗时。通过 hash 链实现 tamper-evident。
_Avoid_: 操作日志、query log、slow log

**Dashboard**:
本地 Web 控制台。`xizhao dashboard` 命令按需启动，默认 `localhost:9020`，Jupyter 风格 token 认证。用于连接配置、策略调整、审计查看、审批处理。
_Avoid_: Web 后台、管理面板、admin panel

**API Key**:
**v2 概念**。Server 模式下用户调用 MCP 工具的认证凭证。由管理员创建并分发给同事，绑定到一个用户身份。Client 模式（v1）不需要 API Key。
_Avoid_: token、密钥、access key

## 角色

**调用者 (Caller)**:
某次 MCP 工具调用的发起方。在审计日志中指代"谁触发了这条 SQL"。**Client 模式始终为 "local"（本机开发者）**；Server 模式为某个具体 User。
_Avoid_: 触发者、invoker

**MCP 客户端 (MCP Client)**:
调用 Xizhao 的前端应用，例如 Claude Code、Codex、Cursor。Xizhao 不实现客户端，只实现服务端。
_Avoid_: AI 端、前端、调用端

**管理员 (Admin)** / **用户 (User)**:
**v2 概念**，仅在 Server 模式下存在。Admin 配置连接、创建用户、签发 API Key；User 通过 API Key 调用 MCP 工具。**Client 模式（v1）无此区分**——本机开发者拥有全部权限。
_Avoid_: 超级用户、root、终端用户、操作员

**审批人 (Approver)**:
**v1 = 调用者自己**（self-approve，在 Dashboard 操作）。**v2 = 拥有审批权限的角色**。
_Avoid_: reviewer、authorizer

## 边界

**不在 v1 范围内**:

- 生产数据库访问
- 多租户 / 跨组织隔离
- 表级 / 行级 / 列级权限
- 多人 RBAC（v1 是单用户，无 admin/user 区分）
- 合规报告、SOC2、ISO27001 之类
- 高可用、横向扩展
- Webhook 通知、SaaS 部署

**v1 包含（PRD 原本标 P2 / 砍掉、后又加回的）**:

- Self-approval 工作流（开发者审批自己 AI 的请求，见 [ADR-0008](./docs/adr/0008-policy-rules-and-approval-workflow.md)）
