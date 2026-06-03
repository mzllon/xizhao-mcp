# Stage 02：自身存储、路径与加密

> **输入：** Stage 01 骨架
> **输出：** 跨平台路径解析 + SQLite 单文件存储（WAL）+ AES-256-GCM 加密 + master key 管理
> **依赖：** Stage 01
> **关联 ADR：** [0006](../adr/0006-credential-encryption-and-master-key.md)、[0012](../adr/0012-misc-decisions.md)

## 目标

实现本地存储基础设施。后续阶段（连接、审计、审批）都基于此。

**关键决策：单 SQLite 文件 + WAL 模式**，让 Dashboard 与 Client 进程能并发访问。

## 文件清单

- 创建：`src/core/app-paths.ts`
- 创建：`src/core/storage.ts`
- 创建：`src/core/schema.ts`（drizzle schema）
- 创建：`src/core/crypto.ts`
- 创建：`drizzle.config.ts`
- 创建：`drizzle/0000_initial.sql`（迁移文件）
- 创建：`tests/unit/core/crypto.test.ts`
- 创建：`tests/unit/core/storage.test.ts`
- 创建：`tests/unit/core/app-paths.test.ts`

## 详细步骤

### 2.1 跨平台路径

- [ ] 实现 `src/core/app-paths.ts`：
  ```ts
  import envPaths from 'env-paths';
  import path from 'node:path';
  
  export function getAppDir(opts?: { override?: string }): string {
    if (opts?.override) return path.resolve(opts.override);
    const paths = envPaths('xizhao', { suffix: '' });
    return paths.data;   // macOS: ~/Library/Application Support/xizhao
                          // Linux: ~/.local/share/xizhao
                          // Windows: %LOCALAPPDATA%\xizhao\Data
  }
  
  // 但默认配置目录我们用 ~/.xizhao 而非 env-paths 默认,与 ADR-0007 一致
  export function getDefaultAppDir(): string {
    const home = process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'];
    return path.join(home!, '.xizhao');
  }
  
  export function getPaths(appDir?: string) {
    const dir = appDir ?? (process.env.XIZHAO_HOME ?? getDefaultAppDir());
    return {
      dir,
      configDb: path.join(dir, 'config.db'),
      masterKey: path.join(dir, 'master.key'),
      dashboardToken: path.join(dir, 'dashboard.token'),
      logsDir: path.join(dir, 'logs'),
      logFile: path.join(dir, 'logs', 'xizhao.log'),
    };
  }
  ```

### 2.2 SQLite 存储

- [ ] 实现 `src/core/schema.ts`（drizzle schema）：
  - `connections` 表：参考 ADR-0006 line 49-59
  - `audit_log` 表：参考 ADR-0004（含 `prev_hash` / `payload` / `hash` 字段）
  - `approval_tasks` 表：参考 ADR-0008 line 95-110
  - 不创建 `users` / `api_keys` / `sessions` 表（v2）
- [ ] 实现 `src/core/storage.ts`：
  - `openStorage(appDir?: string): Database`
  - 创建目录（`{appDir}`、`{appDir}/logs`）
  - 用 better-sqlite3 打开 `{appDir}/config.db`
  - **必须设置 WAL**：
    ```ts
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');   // 5s 等待其他进程释放锁
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');  // WAL 下安全
    ```
  - 跑 drizzle migration（首次创建表）
  - 返回 `Database` 实例 + 关闭方法
- [ ] 实现 `closeStorage(db)`：安全关闭 SQLite 句柄

### 2.3 Master Key

- [ ] 实现 `loadOrCreateMasterKey(opts) -> Buffer`：
  - 默认路径 `~/.xizhao/master.key`
  - 环境变量 `XIZHAO_MASTER_KEY_FILE` 可覆盖路径
  - 文件不存在时生成 32 字节随机数、写入（mode `0o600`）、返回
  - 文件存在时读取并验证长度为 32 字节
  - 文件长度错误时抛 `XIZhaoError('MASTER_KEY_CORRUPT')`
- [ ] 实现密钥指纹（用于 Dashboard 健康卡片显示）：`getKeyFingerprint(key) -> string`（SHA256 前 8 位 hex）

### 2.4 AES-256-GCM 加密

- [ ] 实现 `encryptSecret(plaintext: string, masterKey: Buffer) -> string`：
  - 12 字节随机 IV
  - `aes-256-gcm` 加密
  - 输出 `base64(iv || tag || ciphertext)`
- [ ] 实现 `decryptSecret(payload: string, masterKey: Buffer) -> string`：
  - 解析 base64
  - 前 12 字节为 IV、接下来 16 字节为 auth tag、剩余为 ciphertext
  - 任何解码错误抛 `XizhaoError('DECRYPT_FAILED')`
- [ ] 实现 `rotateMasterKey(oldKey, newKey, allEncryptedRecords)`（v2 用，先预留接口）

### 2.5 测试

- [ ] 测试用例（crypto）：
  - 加密 → 解密往返一致
  - 同一明文加密两次，密文不同（IV 随机性）
  - 篡改 ciphertext 1 字节 → 解密抛错
  - 用错误 key 解密 → 抛错
  - 空字符串加密 → 正常工作
  - 跨进程：A 进程加密、B 进程解密（验证序列化）
  - **自己写 5 个探针实验验证理解（参考讨论中的 L3 学习模式）**
- [ ] 测试用例（storage）：
  - `ensureStorage()` 创建空目录结构
  - WAL pragma 生效（查询 `journal_mode` 返回 `wal`）
  - `busy_timeout` 设置为 5000
  - 两个进程同时打开同一数据库，第二个能读但不能并发写（验证 busy_timeout）
  - migration 幂等：跑两次不出错

## 验收

```bash
pnpm test:unit tests/unit/core/crypto.test.ts tests/unit/core/storage.test.ts tests/unit/core/app-paths.test.ts
pnpm test:coverage -- src/core/crypto.ts src/core/storage.ts
```

预期：
- 所有测试通过
- `src/core/crypto.ts` 覆盖率 ≥ 95%
- `src/core/storage.ts` 覆盖率 ≥ 85%
- 临时目录中能看到 `config.db`（WAL 模式）、`master.key`（mode 600）、`logs/`

## 关键技术点

### SQLite WAL 模式

- WAL（Write-Ahead Logging）允许并发读者 + 单写者
- `busy_timeout = 5000` 让写冲突时等待 5 秒而不是立即报错
- 这两个设置是 Dashboard 与 Client 并发的关键基础
- 见 [SQLite WAL 文档](https://www.sqlite.org/wal.html)

### AES-256-GCM IV 复用的后果

- **IV 永远不能在同一 key 下复用**
- 复用导致：攻击者可还原明文 XOR 差、伪造 auth tag
- 实现时**必须**每次加密都新生成 IV（`crypto.randomBytes(12)`）
- 这是为什么我们存 `iv || tag || ciphertext` 而不是只存 `tag || ciphertext`

### Master Key 文件权限

- Unix：`0o600`（仅 owner 可读写）
- Windows：通过 `icacls` 限制（实现时研究 best practice）
- 如果无法设置权限（如某些容器环境），打印警告但不阻止

## 实施风险

| 风险 | 应对 |
|------|------|
| better-sqlite3 在 Windows ARM 上无 prebuilt | 锁定 x64 构建，文档说明 |
| WAL 模式在 SMB / NFS 共享目录下不工作 | 文档说明必须本地文件系统 |
| `XIZHAO_HOME` 在测试时未清理导致测试间污染 | 测试用 `beforeEach` 创建临时目录 |
