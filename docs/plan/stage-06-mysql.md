# Stage 06：MySQL 执行层

> **输入：** Stage 03 连接配置就绪
> **输出：** mysql2 连接池 + 4 个执行函数（executeSql / explainSql / listTables / describeTable）+ 5 秒查询超时 + 结果截断
> **依赖：** Stage 03
> **关联 ADR：** [0010](../adr/0010-mcp-implementation.md)、[0012](../adr/0012-misc-decisions.md)

## 目标

实现 MySQL 访问的执行层。所有 SQL 执行都经过这里，是策略引擎通过后的下一步。

## 文件清单

- 创建：`src/core/mysql.ts`
- 创建：`tests/integration/mysql.test.ts`
- 创建：`tests/integration/execute-sql.test.ts`

## 详细步骤

### 6.1 连接池

- [ ] `src/core/mysql.ts`：
  ```ts
  import mysql from 'mysql2/promise';
  
  const pools = new Map<string, mysql.Pool>();   // connectionName → pool
  
  export function getPool(conn: Connection): mysql.Pool {
    if (pools.has(conn.name)) return pools.get(conn.name)!;
    const pool = mysql.createPool({
      host: conn.host,
      port: conn.port,
      user: conn.username,
      password: conn.password,
      database: conn.defaultSchema,
      connectionLimit: 5,
      queueLimit: 10,
      waitForConnections: true,
      connectTimeout: 10_000,
      enableKeepAlive: true,
      timezone: 'Z',         // UTC,统一在应用层处理时区
      dateStrings: false,
      typeCast: function (field, next) {
        // BIGINT 默认返回字符串,避免 JS 精度
        if (field.type === 'BIGINT') return String(field.string());
        return next();
      },
    });
    pools.set(conn.name, pool);
    return pool;
  }
  
  export async function closeAllPools(): Promise<void> {
    await Promise.all([...pools.values()].map(p => p.end()));
    pools.clear();
  }
  ```

### 6.2 executeSql

- [ ] 实现 `executeSql(conn, sql, options): Promise<SqlResult>`：
  ```ts
  type SqlResult =
    | { kind: 'select'; columns: string[]; rows: Record<string, unknown>[]; rowCount: number; truncated: boolean }
    | { kind: 'modify'; affectedRows: number }
    | { kind: 'ddl'; durationMs: number };
  ```
- [ ] **5 秒查询超时**（关键）：
  - 用 `MAX_EXECUTION_TIME(5000)` hint（仅 SELECT）
    ```sql
    SELECT /*+ MAX_EXECUTION_TIME(5000) */ ... FROM ...
    ```
  - 用 mysql2 的 `timeout: 5000` 选项（DML / DDL 用）
  - 超时后用 `KILL QUERY <thread_id>` 清理（防止 MySQL 继续跑）
  - 抛 `XizhaoError('TIMEOUT')`
- [ ] **结果截断**：
  - 默认 maxLimit 来自连接的 policy.maxLimit（通常 1000）
  - 如果 SELECT 不带 LIMIT 或 LIMIT > maxLimit → 策略引擎已经拦下，不会到这一层
  - 如果实际返回行数 = maxLimit → 标记 `truncated: true`（可能还有更多）
  - 实现方式：`if (rows.length >= maxLimit) truncated = true`
- [ ] **多语句检查**：
  - mysql2 默认禁用 `multipleStatements`，安全
  - 但要防御 `mysql.format` 误用
- [ ] **错误分类**：
  - `ER_ACCESS_DENIED_ERROR` 等 → `MYSQL_ERROR` + 原始 code
  - `ER_PARSE_ERROR` → `SQL_SYNTAX_ERROR`（与策略层 parse-error 不同，这是 MySQL 解析错）
  - 超时 → `TIMEOUT`
  - 其他 → `MYSQL_ERROR`

### 6.3 explainSql

- [ ] 实现 `explainSql(conn, sql): Promise<{ plan: any }>`：
  - 执行 `EXPLAIN FORMAT=JSON <sql>`
  - 直接返回 MySQL 的 JSON 输出，不二次加工（参考 ADR-0003）
  - 也应用 5 秒超时
- [ ] 注意：`EXPLAIN` 不执行 SQL，所以即使 SQL 有问题也会返回计划

### 6.4 listTables

- [ ] 实现 `listTables(conn, schema?): Promise<{ name; type; rowCount? }[]>`：
  - 查询 `information_schema.tables`：
    ```sql
    SELECT TABLE_NAME as name, TABLE_TYPE as type, TABLE_ROWS as rowCount
    FROM information_schema.tables
    WHERE TABLE_SCHEMA = ?
    ```
  - **不缓存**（ADR-0012 决策）

### 6.5 describeTable

- [ ] 实现 `describeTable(conn, table): Promise<{ ddl; rowCount? }>`：
  - 执行 `SHOW CREATE TABLE \`<table>\``
  - 取第二列（DDL 字符串）
  - 同时查 `information_schema.tables.TABLE_ROWS` 取近似行数
  - 直接返回 DDL（参考 ADR-0003）

### 6.6 优雅关闭

- [ ] 实现 `closePool(connName)`：单独关闭某个连接的池
- [ ] 已实现的 `closeAllPools()`：用于进程退出

### 6.7 集成测试

- [ ] `tests/integration/mysql.test.ts`：
  - 用 `@testcontainers/mysql` 启动 MySQL 8 容器
  - 测试 SELECT / INSERT / UPDATE / DELETE / DDL 全流程
  - 测试 5 秒超时（用 `SLEEP(10)` 触发）
  - 测试结果截断（插入 1100 行后 SELECT LIMIT 1000）
  - 测试 EXPLAIN FORMAT=JSON 输出
  - 测试 list_tables / describe_table
  - 测试 MySQL 错误（如访问不存在的表）

## 验收

```bash
pnpm test:integration tests/integration/mysql.test.ts tests/integration/execute-sql.test.ts
```

预期：
- 所有测试通过（需要 Docker）
- 真实 MySQL 8 下：
  - SELECT 1000 行返回 + truncated: true
  - `SELECT SLEEP(10)` 在 5 秒后抛 TIMEOUT
  - DDL（CREATE TABLE）成功执行
  - 错误情况返回明确错误码

## 关键技术点

### MAX_EXECUTION_TIME hint 的局限

- 仅对 SELECT 有效
- 对 INSERT/UPDATE/DELETE/DDL 无效
- 替代方案：mysql2 的 `timeout` 选项 + 手动 `KILL QUERY`
- `KILL QUERY` 需要 PROCESS 权限（最小权限设计时注意）

### BIGINT 处理

- JS Number 安全整数范围：2^53-1
- BIGINT 超过此范围会丢精度
- 默认用 typeCast 转字符串，应用层需要时再 BigInt() 解析

### 时区统一

- mysql2 设置 `timezone: 'Z'`
- 所有时间戳以 UTC 存储
- 应用层展示时再转本地时区

### connection pool 共享

- 同一 Connection 名共享 pool
- 删除连接时（`xizhao conn delete`）需要先 `closePool`
- 否则连接池保持旧凭证

## 实施风险

| 风险 | 应对 |
|------|------|
| testcontainers 在 Windows / macOS ARM 上启动慢 | CI 用 Linux；本地慢点接受 |
| MySQL 8.4 / 9.x 语法变化 | 测试矩阵扩展版本（v2），v1 锁 8.0 / 8.4 |
| KILL QUERY 权限不足 | 最小权限 SQL 文档说明需要 PROCESS |
| `SHOW CREATE TABLE` 输出格式跨版本差异 | mysql2 解析后取 DDL 列，应该稳定 |
