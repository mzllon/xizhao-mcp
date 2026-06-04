# 0014: 连接描述与项目级默认值 —— 让 AI 不再猜连接

**Status**: Accepted
**Date**: 2026-06-04
**Related**: ADR-0010（MCP 工具契约）、ADR-0007（Client 模式优先）

## Context

`list_connections` 工具让 AI 能发现所有可用连接，但当存在多个连接时，AI 无法判断当前项目应该用哪一个。开发者不得不在每次对话中手动告知 AI "用 dev-a 连接"。

MCP 客户端（Claude Code / Codex / Cursor / OpenCode 等）支持两种配置级别：

| 级别   | 配置位置                          | 进程模型                     |
| ------ | --------------------------------- | ---------------------------- |
| 用户级 | `~/.claude/settings.json`         | 一个 xizhao 进程服务所有项目 |
| 项目级 | `<project>/.claude/settings.json` | 每个项目独立进程             |

项目级配置可以通过 CLI 参数传递默认值；但用户级配置只有一个进程，无法按项目区分参数。

**关键约束**：

- Stdio MCP 协议没有项目上下文概念——服务端不知道 AI 在操作哪个项目。
- `process.cwd()` 是否指向项目目录取决于客户端实现，不可靠。
- 不能要求 MCP 客户端做任何适配。
- 但 AI 自己知道当前项目（能读到项目目录、CLAUDE.md 等）。

## Decision

采用三层叠加方案，信息从服务端 + AI 两侧共同提供，不依赖 cwd 感知。

### 第一层：连接描述（Connection Description）

在连接配置中增加 `description` 字段——一段由开发者填写的自由文本，说明该连接的用途和适用项目。

**存储变更**：

- `connections` 表增加 `description TEXT` 列（可为空）
- `Connection`、`ConnectionInfo`、`ConnectionInput` 接口增加 `description?: string`
- `xizhao setup` / `xizhao conn add` 增加 `--description` 参数和交互式输入
- Dashboard 连接编辑页增加描述字段

**`list_connections` 响应变更**：

```ts
// 之前
{
  connections: [{ name, host, port, username, defaultSchema, policy }];
}

// 之后
{
  connections: [
    { name, host, port, username, defaultSchema, policy, description },
  ];
}
```

AI 看到如下响应后即可准确选择：

```json
{
  "connections": [
    {
      "name": "dev-a",
      "host": "10.0.1.5",
      "defaultSchema": "app_a",
      "description": "项目A开发库，仅限 app_a schema"
    },
    {
      "name": "dev-b",
      "host": "10.0.1.6",
      "defaultSchema": "app_b",
      "description": "项目B开发库"
    }
  ]
}
```

### 第二层：CLI 参数（项目级 MCP 配置专用）

`xizhao client` 新增两个可选参数：

```
xizhao client [--default-connection <name>] [--default-schema <schema>]
```

等价环境变量（优先级低于 CLI 参数）：

- `XIZHAO_DEFAULT_CONNECTION`
- `XIZHAO_DEFAULT_SCHEMA`

**项目级 MCP 配置示例**：

```jsonc
// <project>/.claude/settings.json
{
  "mcpServers": {
    "xizhao": {
      "command": "xizhao",
      "args": [
        "client",
        "--default-connection",
        "dev-a",
        "--default-schema",
        "app_a",
      ],
    },
  },
}
```

**行为变更**（仅当参数存在时）：

1. `list_connections` 响应增加顶层字段：

   ```json
   {
     "defaultConnection": "dev-a",
     "defaultSchema": "app_a",
     "connections": [...]
   }
   ```

2. 其他工具的 description 动态注入默认值：

   ```
   // connection 参数的 description
   // 有 default 时：
   "Connection alias name. Default: \"dev-a\""
   // 无 default 时（当前行为）：
   "Connection alias name (from list_connections)"
   ```

3. 不改变任何工具的参数 schema——`connection` 仍为必填参数。只是 description 变了，AI 看到就知道该传什么。

### 第三层：项目指令文件（软约束兜底）

对于用户级 MCP 配置（单进程多项目），开发者可在项目的 CLAUDE.md（或等效项目指令文件）中写一句：

```markdown
## 数据库

使用 xizhao 的 "dev-a" 连接，schema 为 "app_a"
```

无需任何代码改动，所有 MCP 客户端都支持项目级指令文件。AI 读取后遵循。

### 优先级与叠加

三层独立工作，不互斥：

```
优先级从高到低：
1. CLI 参数 → 硬保证（项目级 MCP 配置）
2. 连接描述 → AI 侧判断（所有配置级别）
3. 项目指令文件 → 软约束（所有配置级别）
```

对于用户级 MCP 配置，第 1 层不可用，靠第 2 + 3 层组合。对于项目级配置，三层全部可用，第 1 层覆盖其余。

## Consequences

**正面**：

- 不依赖 cwd、不引入新配置文件格式、不要求客户端适配。
- 连接描述对所有配置级别都有价值——即使只有一个连接，描述也能帮助 AI 理解上下文。
- CLI 参数利用 MCP 客户端原生机制，100% 可靠。
- 项目指令文件零成本、全客户端兼容。

**已接受的代价**：

- 连接描述依赖开发者填写。如果开发者不写，AI 只能靠连接名和 schema 猜测。`xizhao setup` 应鼓励（但不强制）填写。
- CLI 参数对用户级 MCP 配置无效。这是 MCP 架构的固有限制，不是我们的 bug。
- 项目指令文件是软约束，AI 理论上可能不遵循。实际中 Claude / GPT 等对指令文件遵循度很高。

**不做的事**：

- 不实现 `.xizhao.json` 项目配置文件——服务端无法可靠感知项目目录。
- 不让 `connection` 参数变为可选——保持工具契约简洁，避免隐式状态。
- 不实现 `set_project` / `use` 之类的会话工具——增加复杂度但价值有限。

## 实施范围

### 数据层

- `connections` 表增加 `description TEXT` 列
- `Connection`、`ConnectionInfo`、`ConnectionInput` 类型增加 `description`
- 数据迁移（SQLite `ALTER TABLE ... ADD COLUMN`，向后兼容）

### CLI

- `xizhao client` 新增 `--default-connection` / `--default-schema` 参数
- `xizhao setup` / `xizhao conn add` 增加 description 交互式输入
- `xizhao conn edit` 支持修改 description

### MCP Server

- `createMcpServer` 接受可选的 `defaultConnection` / `defaultSchema` 参数
- `list_connections` handler 响应增加 `defaultConnection?` / `defaultSchema?` 字段，以及每条连接的 `description`
- 其余 4 个带 `connection` 参数的工具，description 动态注入默认值

### Dashboard

- 连接列表 / 编辑页展示 description 字段
