# Stage 09：Dashboard

> **输入：** Stage 08 完整审批闭环
> **输出：** 本地 Web 控制台（10 页）+ Jupyter 风格 token 认证 + 与 Client 进程并发
> **依赖：** Stage 08
> **关联 ADR：** [0009](../adr/0009-dashboard-and-tech-stack.md)、[0006](../adr/0006-credential-encryption-and-master-key.md)、[0012](../adr/0012-misc-decisions.md)

## 目标

把 Xizhao 从"命令行工具"升级为"可视化产品"。Dashboard 是作品集 README 头图的来源，也是 self-approval 工作流的必经环节。

**关键挑战：与 `xizhao client` 进程并发访问同一 SQLite**——本阶段必须把 stage 02 的 WAL 配置用到极致。

## 文件清单

- 创建：`src/web/server.ts`（Hono 入口）
- 创建：`src/web/auth.ts`（Jupyter token 认证）
- 创建：`src/web/api/connections.ts`
- 创建：`src/web/api/policy.ts`
- 创建：`src/web/api/audit.ts`
- 创建：`src/web/api/approvals.ts`
- 创建：`src/web/api/settings.ts`
- 创建：`src/web/api/dashboard.ts`（概览页聚合 API）
- 创建：`src/web/frontend/`（Next.js 14 项目）
- 创建：`src/web/frontend/app/layout.tsx`
- 创建：`src/web/frontend/app/page.tsx`（概览页）
- 创建：`src/web/frontend/app/connections/page.tsx` + 子页面
- 创建：`src/web/frontend/app/policy/[name]/page.tsx`
- 创建：`src/web/frontend/app/audit/page.tsx` + `[id]/page.tsx`
- 创建：`src/web/frontend/app/approvals/page.tsx` + `[taskId]/page.tsx`
- 创建：`src/web/frontend/app/approve/[taskId]/page.tsx`（重定向）
- 创建：`src/web/frontend/app/settings/page.tsx`
- 创建：`src/web/frontend/components/`（shadcn/ui 组件）
- 创建：`src/web/frontend/lib/api.ts`（fetch 封装）
- 修改：`src/cli/commands/dashboard.ts`（覆盖 stage 03 占位）
- 创建：`tests/unit/web/auth.test.ts`
- 创建：`tests/integration/web-api.test.ts`

## 详细步骤

### 9.1 后端：Hono 服务

- [ ] `src/web/server.ts`：
  ```ts
  import { Hono } from 'hono';
  import { serve } from '@hono/node-server';
  import { authMiddleware } from './auth.js';
  import connectionsApi from './api/connections.js';
  // ... 其他 API
  
  const app = new Hono();
  
  // 静态文件 (Next.js 导出产物)
  app.use('/*', serveStatic({ root: './dist-web' }));
  
  // API 路由
  app.route('/api', authMiddleware);
  app.route('/api/connections', connectionsApi);
  app.route('/api/policy', policyApi);
  app.route('/api/audit', auditApi);
  app.route('/api/approvals', approvalsApi);
  app.route('/api/settings', settingsApi);
  app.route('/api/dashboard', dashboardApi);
  
  export function startDashboardServer(opts: { port: number; token: string }) {
    serve({ fetch: app.fetch, port: opts.port });
  }
  ```

### 9.2 Token 认证

- [ ] `src/web/auth.ts`：
  - 启动时从 `~/.xizhao/dashboard.token` 读 token（CLI 启动时写入）
  - 第一次访问必须带 `?token=xxx`
  - 验证通过 → 设置 cookie `xizhao_session` (HttpOnly + SameSite=Strict + 仅 HTTPS 时 Secure)
  - 后续访问：cookie 有效即放行
  - 无 cookie 且无 token 参数 → 返回 HTML 页面要求输入 token
- [ ] **cookie 值**：用 `crypto.randomBytes(32).toString('base64url')`
- [ ] **session 表**（暂时用内存 Map 或 SQLite `dashboard_sessions` 表）

### 9.3 端口递增

- [ ] 启动逻辑：
  ```ts
  async function findPort(start: number, end: number): Promise<number> {
    for (let port = start; port <= end; port++) {
      if (await isPortAvailable(port)) return port;
    }
    throw new Error(`No available port in ${start}-${end}`);
  }
  
  const port = await findPort(9020, 9025);
  ```
- [ ] 全部占用 → 报错并提示用户手动指定 `--port`

### 9.4 API 路由

- [ ] **`/api/dashboard/overview`**：聚合数据
  ```json
  {
    "connectionsCount": 3,
    "pendingApprovals": 2,
    "auditStats": { "last24h": { "total": 145, "denied": 3, "needApproval": 2 } },
    "masterKey": { "fingerprint": "abc12345", "lastModified": "..." }
  }
  ```
- [ ] **`/api/connections`**：GET 列表 / POST 创建 / PATCH 更新 / DELETE 删除
- [ ] **`/api/connections/:name/test`**：POST 测试连接
- [ ] **`/api/policy/:connName`**：GET 当前策略 / PATCH 更新
- [ ] **`/api/audit`**：GET 分页查询（filters: since, denyOnly, sql, connection, limit）
- [ ] **`/api/audit/:id`**：GET 详情
- [ ] **`/api/approvals`**：GET pending + 历史
- [ ] **`/api/approvals/:taskId`**：GET 详情
- [ ] **`/api/approvals/:taskId/approve`**：POST，body 可带 `{ modifiedSql, note }`
- [ ] **`/api/approvals/:taskId/deny`**：POST，body 可带 `{ note }`
- [ ] **`/api/settings`**：GET / PATCH（默认预设、过期时间、清理审计按钮）

### 9.5 与 Client 进程的并发协调

**核心问题**：用户在 AI 会话中调 `xizhao client`（进程 A），同时打开 Dashboard（进程 B）。两边都访问 `~/.xizhao/config.db`。

- [ ] **基础**：stage 02 已配置 WAL + busy_timeout=5000，理论上支持并发
- [ ] **配置热更新**（关键）：
  - 用户在 Dashboard 改了连接配置 → Client 必须感知
  - 方案：Dashboard 进程写 SQLite 后，向 `~/.xizhao/reload.signal` 文件写时间戳
  - Client 进程用 `fs.watch()` 监听该文件，变化时清缓存（重读 connections 表）
  - 或者更简单：Client 进程每次工具调用都**重新查询**连接（不缓存），代价是每次多一次 SQLite 读
  - **推荐方案**：每次重新查询（dev/test 场景无性能压力）
- [ ] **连接池失效**：
  - 如果用户改了连接的 host/password，旧 pool 没用
  - `getPool()` 内部检查连接的最新 `updated_at`，变了就 `pool.end()` 重建
- [ ] **审批同步**：
  - Client 进程的 approval.ts 修改 SQLite 后，Dashboard 进程的 pending 列表要立即看到
  - SQLite WAL 模式下 reader 自动看到新写入，无需额外通知
  - Dashboard 前端用 polling（每 5 秒）刷新 pending 列表
- [ ] **migration 协调**：
  - 哪个进程先启动就跑 schema migration？
  - 方案：用 `~/.xizhao/.migration-lock` 文件锁
  - 进程启动时尝试 `flock`（-exclusive）拿锁，拿到就跑 migration
  - 拿不到就等待最多 5 秒，然后跳过 migration 假设 schema 已就绪

### 9.6 前端：Next.js 14

- [ ] 用 `pnpm create next-app` 在 `src/web/frontend/` 创建项目
- [ ] 配置 Tailwind + shadcn/ui CLI 初始化
- [ ] **App Router** 而非 Pages Router
- [ ] **客户端组件**为主（不需要 SSR）
- [ ] 页面实现：
  - `/`：概览，3 个卡片（连接数、待审批、近 24h 调用统计）+ 主密钥健康卡片
  - `/connections`：表格 + 新建按钮
  - `/connections/new`：表单（参考 setup 向导，但是是表单版）
  - `/connections/[name]`：编辑 + 测试按钮
  - `/policy/[name]`：策略编辑（statement types 开关 + maxLimit 滑块）
  - `/audit`：表格 + 过滤栏 + 分页
  - `/audit/[id]`：详情（完整 SQL、策略判定、执行结果）
  - `/approvals`：表格（pending 置顶 + 历史）
  - `/approvals/[taskId]`：单任务审批（SQL 高亮 + 同意/拒绝/修改后同意按钮）
  - `/approve/[taskId]`：服务端重定向到 `/approvals/[taskId]`（让 AI 给的短链接直接跳到完整审批页）
  - `/settings`：默认预设、过期时间、清理审计按钮、master.key 信息
- [ ] **UI 语言**：中文
- [ ] **错误详情**：保留英文 code + message
- [ ] **SQL 高亮**：用 [`shiki`](https://github.com/shikijs/shiki) 或 [`prismjs`](https://prismjs.com/)

### 9.7 命令实现

- [ ] `src/cli/commands/dashboard.ts`：
  ```ts
  import { getPaths } from '../../core/app-paths.js';
  import { startDashboardServer } from '../../web/server.js';
  import { randomBytes } from 'node:crypto';
  import { writeFileSync, unlinkSync } from 'node:fs';
  import open from 'open';
  
  export async function dashboardCommand(opts: { port?: number }) {
    const paths = getPaths();
    
    // 1. 生成 token
    const token = randomBytes(32).toString('base64url');
    writeFileSync(paths.dashboardToken, token, { mode: 0o600 });
    
    // 2. 找可用端口
    const port = opts.port ?? await findPort(9020, 9025);
    
    // 3. 启动 server
    startDashboardServer({ port, token });
    
    // 4. 自动开浏览器
    const url = `http://localhost:${port}/?token=${token}`;
    console.log(`🚀 Dashboard: ${url}`);
    await open(url);
    
    // 5. 注册退出清理
    process.on('exit', () => unlinkSync(paths.dashboardToken));
    process.on('SIGINT', () => process.exit(0));
  }
  ```

### 9.8 浏览器断开自动退出

- [ ] Dashboard 启动时记录最后活动时间
- [ ] API 调用更新最后活动时间
- [ ] setInterval 每 10 秒检查：如果浏览器超过 5 秒无活动 + 未在 polling → 准备退出
- [ ] 实际实现：用一个 WebSocket 心跳或轮询 `/api/ping` 检测
- [ ] **简化方案**：保留进程运行，让用户手动 Ctrl+C 退出（更符合直觉）

### 9.9 测试

- [ ] **auth.test.ts**：
  - 无 token 访问 → 401
  - 带 token 访问 → 200 + 设置 cookie
  - 后续带 cookie 访问 → 200
  - 关闭 dashboard → token 文件删除
- [ ] **web-api.test.ts**：
  - 各 API 端点的成功 / 失败
  - 审批 approve / deny / modify-approve
  - 配置热更新（mock 两进程）
  - 端口递增逻辑

## 验收

```bash
pnpm test:unit tests/unit/web/
pnpm test:integration tests/integration/web-api.test.ts
pnpm build
node dist/cli/index.js dashboard --port 9020
# 浏览器自动开,显示 token 输入或直接进入
```

预期：
- 所有测试通过
- token 鉴权生效
- 审批页面能 approve / deny / modify-approve
- 与 `xizhao client` 同时跑时无 SQLite 锁错误
- Dashboard 改连接配置 → Client 下次工具调用看到新配置

## 关键技术点

### SQLite 并发模式

- **WAL**：多 reader + 单 writer
- **busy_timeout = 5000**：写冲突时等 5 秒
- **短事务**：每个 API 请求的事务必须 < 100ms
- **禁止**：长事务（如导出大量审计日志时用流式 + 不持锁）

### 配置热更新的取舍

- 方案 A：每次工具调用都查 SQLite（最简单，性能可接受）
- 方案 B：fs.watch + 信号文件（复杂，但 Client 缓存连接）
- v1 推荐方案 A（性能不是瓶颈，简单可靠）

### Next.js 静态导出 vs 服务端运行

- v1 用 Next.js 静态导出（`next build && next export`），Hono serve 静态文件
- 不用 Next.js 自带 server（简化部署）
- 也不需要 SSR（本地工具，SEO 无关）

### shadcn/ui 的工作模式

- 不是 npm 包，而是 copy 到 `src/web/frontend/components/ui/` 的源码
- 用 `npx shadcn-ui add button` 添加组件
- 项目内可自由修改（不像普通 npm 包）

## 实施风险

| 风险 | 应对 |
|------|------|
| Windows 上 `fs.watch` 不稳定 | 改用方案 A（每次重查 SQLite），不依赖 fs.watch |
| Next.js 14 App Router 仍在 beta | 锁定 14.x 稳定版本，不追最新 |
| shadcn/ui 组件冲突 Tailwind 配置 | 用 shadcn 默认配置，不深度定制 |
| Dashboard 启动时 Client 也在跑 | 测试覆盖，确保两进程不互锁 |
| 浏览器自动开在 SSH 远程会话失败 | 检测 DISPLAY 环境，无则只打印 URL |
