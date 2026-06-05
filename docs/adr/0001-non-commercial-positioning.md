# 0001: 项目定位 —— 非商业化的部门级内部工具 + 作品集

**Status**: Accepted (parts superseded by ADR-0007 and ADR-0008)
**Date**: 2026-06-02

## Context

XM的 PRD v1.0 最初以"AI 访问数据库的安全代理与治理平台"为定位，覆盖 Client / Server 双模式、审批流、多租户、合规等完整治理栈。但深入分析后发现：

- **商业化可能性极低**。开源 MCP MySQL Server 已有 4 个以上免费替代（f4ww4z、designcomputer、TabularisDB、huangfeng19820712），中间件层难以收租，国内 SaaS 订阅对开发工具价格敏感，企业级治理市场（Satori / Immuta / Privacera）已有强劲对手。
- **真实使用场景是部门级内部工具**。约 10 人小团队（AI 开发同事 + 非技术 PM + DBA），仅访问 dev / test 库，部署在公司内网单台服务器，无 SSO、无合规要求。
- **同时承担作品集与学习目标**。借此项目学习 Node.js（TypeScript / ESM / 异步 / 流）、MCP 协议、SQL 解析。

## Decision

XM v1 定位为：**部门级内部工具 + 开源作品集 + Node.js / MCP 学习载体**。

具体边界：

1. **单租户、单组织、单实例部署**。一套 Server 服务一个团队（约 10 人），不做租户隔离。
2. **仅访问 dev / test 库，不接入生产**。所有围绕生产库设计的复杂度（双人复核、表级权限、行级脱敏、合规报告）整体砍掉。
3. ~~**用户角色简化为 admin / user 两档**。不做细粒度 RBAC。~~ **[Superseded by ADR-0007]** v1 是 Client 模式单用户，无 admin/user 区分。两档角色仅在 v2 Server 模式适用，详见 [ADR-0005](./0005-auth-and-api-key-design.md)。
4. ~~**审批流（AP-01..05）整体推迟到 v2**~~ **[Superseded by ADR-0008]** v1 重新引入 self-approval 工作流（开发者审批自己 AI 的请求），见 [ADR-0008](./0008-policy-rules-and-approval-workflow.md)。多用户审批仍属 v2。
5. **DBA 不在 v1 用户范围内**。审计面板只服务本地开发者（Client 模式）或 admin（Server 模式）的日常运维，不为 DBA 做专门的过滤 / 告警 / 报表功能。
6. **作品集优先级高于功能完备性**。当二者冲突时，砍掉"做出来很完整但用户没有"的功能（如多租户、用户管理 UI），保留"做出来技术含量高、能讲故事"的功能（如 SQL AST 策略引擎、Explain 驱动的 AI 自优化、零配置上手、self-approval 工作流）。

## Consequences

**正面**:

- MVP 工作量从 PRD v1.0 的完整治理栈减少约 30-40%（ADR-0008 加回审批后，比最初估算略增）。
- 架构边界清晰，所有 v1 决策都可基于"Client 单用户 + dev/test 库"这个真实场景判断。
- 自用 + 作品集双重约束互相加强：自用保证产品经过真实测试，作品集保证自用部分得到打磨。

**负面 / 已接受的代价**:

- 未来若要做 SaaS 或商业化，需要重新引入多租户隔离层、租户级加密密钥、跨租户审计。预留 `team_id` 字段做软隔离的成本较低，但硬隔离改造工作量仍不可忽略。
- DBA 群体的需求不在 v1 视野，DBA 可能继续依赖现有 MySQL slow log + ELK 方案，XM不会成为他们的主审计工具。
- 非技术 PM 群体的实际使用依赖他们是否拥有 MCP 客户端（Cursor / Claude Desktop 等）。若 PM 没有这些客户端，"PM 用 AI 查数据"是伪场景。

**未来重新审视的触发条件**:

- 有真实付费客户出现 → 重新评估商业版本（v2+）
- 团队规模超过 50 人 → 重新评估 RBAC 与多用户审批
- 接入生产库的需求出现 → 重新评估表级权限、行级脱敏、双人审批

## Updates / Supersession 历史

- **被 ADR-0007 修改**：v1 第一发布改为 Client 模式优先，Server 模式推后到 v2。原 Decision 中"用户角色简化为 admin / user 两档"在 v1 不适用（无用户）。
- **被 ADR-0008 修改**：v1 重新引入 self-approval 工作流。原 Decision 中"审批流整体推迟到 v2"被推翻。多用户审批仍属 v2。
