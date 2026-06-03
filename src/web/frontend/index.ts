/**
 * Dashboard frontend — single-page application.
 *
 * Embedded HTML/CSS/JS for the Xizhao Dashboard.
 * No build step required — served directly by Hono.
 */
export const dashboardHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>犀照 Dashboard</title>
<style>
:root{--bg:#0f172a;--card:#1e293b;--border:#334155;--text:#e2e8f0;--muted:#94a3b8;--accent:#3b82f6;--danger:#ef4444;--success:#22c55e;--warn:#f59e0b}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
nav{background:var(--card);border-bottom:1px solid var(--border);padding:0 1.5rem;display:flex;align-items:center;gap:2rem;height:3.5rem}
nav .logo{font-weight:700;font-size:1.1rem;color:var(--accent)}
nav a{color:var(--muted);text-decoration:none;font-size:.9rem;padding:.4rem .6rem;border-radius:6px;transition:all .15s}
nav a:hover,nav a.active{color:var(--text);background:var(--border)}
.container{max-width:1200px;margin:0 auto;padding:1.5rem}
h2{font-size:1.3rem;margin-bottom:1rem}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:1rem;margin-bottom:2rem}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:1.2rem}
.card .label{color:var(--muted);font-size:.85rem;margin-bottom:.3rem}
.card .value{font-size:1.8rem;font-weight:700}
.card .sub{color:var(--muted);font-size:.8rem;margin-top:.3rem}
table{width:100%;border-collapse:collapse;background:var(--card);border-radius:10px;overflow:hidden;border:1px solid var(--border)}
th{text-align:left;padding:.75rem 1rem;color:var(--muted);font-size:.8rem;text-transform:uppercase;border-bottom:1px solid var(--border);background:rgba(0,0,0,.2)}
td{padding:.7rem 1rem;border-bottom:1px solid var(--border);font-size:.9rem}
tr:hover td{background:rgba(255,255,255,.03)}
.badge{display:inline-block;padding:.15rem .5rem;border-radius:4px;font-size:.75rem;font-weight:600}
.badge-pending{background:#fbbf2433;color:#fbbf24}
.badge-approved{background:#22c55e33;color:#22c55e}
.badge-denied{background:#ef444433;color:#ef4444}
.badge-consumed{background:#3b82f633;color:#3b82f6}
.badge-expired{background:#64748b33;color:#64748b}
.badge-allow{background:#22c55e33;color:#22c55e}
.badge-deny{background:#ef444433;color:#ef4444}
.badge-need_approval{background:#fbbf2433;color:#fbbf24}
.btn{padding:.4rem .8rem;border:none;border-radius:6px;font-size:.85rem;cursor:pointer;font-weight:500;transition:all .15s}
.btn-approve{background:var(--success);color:#fff}
.btn-approve:hover{background:#16a34a}
.btn-deny{background:var(--danger);color:#fff}
.btn-deny:hover{background:#dc2626}
.btn-sm{padding:.3rem .6rem;font-size:.8rem}
.sql-code{font-family:'Fira Code',monospace;font-size:.85rem;background:#0f172a;padding:.5rem .7rem;border-radius:6px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;max-height:100px;overflow-y:auto;margin:.3rem 0}
.actions{display:flex;gap:.5rem;align-items:center}
textarea{width:100%;background:#0f172a;color:var(--text);border:1px solid var(--border);border-radius:6px;padding:.5rem;font-family:monospace;font-size:.85rem;resize:vertical;min-height:60px}
.filter-bar{display:flex;gap:.5rem;margin-bottom:1rem;flex-wrap:wrap}
.filter-bar input,.filter-bar select{background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:.4rem .7rem;font-size:.85rem}
.filter-bar input{flex:1;min-width:150px}
.empty{text-align:center;padding:3rem;color:var(--muted)}
.tab-content{display:none}
.tab-content.active{display:block}
.pagination{display:flex;gap:.5rem;justify-content:center;margin-top:1rem}
.pagination button{background:var(--card);color:var(--text);border:1px solid var(--border);padding:.3rem .7rem;border-radius:4px;cursor:pointer}
.pagination button:disabled{opacity:.4;cursor:default}
.modal-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:100}
.modal{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:1.5rem;max-width:600px;width:90%;max-height:80vh;overflow-y:auto}
.modal h3{margin-bottom:1rem}
.modal .btn{margin-right:.5rem}
</style>
</head>
<body>
<nav>
  <div class="logo">🔥 犀照</div>
  <a href="#" onclick="showTab('overview')" data-tab="overview">概览</a>
  <a href="#" onclick="showTab('approvals')" data-tab="approvals">审批</a>
  <a href="#" onclick="showTab('connections')" data-tab="connections">连接</a>
  <a href="#" onclick="showTab('audit')" data-tab="audit">审计</a>
</nav>
<div class="container">
  <!-- Overview -->
  <div id="tab-overview" class="tab-content active">
    <div class="cards" id="overview-cards"></div>
  </div>

  <!-- Approvals -->
  <div id="tab-approvals" class="tab-content">
    <h2>待审批</h2>
    <div id="pending-list"></div>
    <h2 style="margin-top:2rem">历史记录</h2>
    <div id="approval-history"></div>
  </div>

  <!-- Connections -->
  <div id="tab-connections" class="tab-content">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
      <h2>连接</h2>
      <button class="btn btn-approve" onclick="showAddConnection()">+ 新建连接</button>
    </div>
    <div id="connections-list"></div>
  </div>

  <!-- Audit -->
  <div id="tab-audit" class="tab-content">
    <h2>审计日志</h2>
    <div class="filter-bar">
      <input id="audit-sql" placeholder="搜索 SQL...">
      <select id="audit-decision"><option value="">全部</option><option value="allow">允许</option><option value="deny">拒绝</option><option value="need_approval">需审批</option></select>
      <button class="btn btn-sm" style="background:var(--accent);color:#fff" onclick="loadAudit()">查询</button>
    </div>
    <div id="audit-table"></div>
    <div class="pagination" id="audit-pagination"></div>
  </div>
</div>

<div id="modal-root"></div>

<script>
const API = '';
let auditOffset = 0;
const LIMIT = 50;

function showTab(name) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('active', a.dataset.tab === name));
  if (name === 'overview') loadOverview();
  if (name === 'approvals') loadApprovals();
  if (name === 'connections') loadConnections();
  if (name === 'audit') loadAudit();
  return false;
}

async function api(path, opts) {
  const r = await fetch(API + path, opts);
  return r.json();
}

// Overview
async function loadOverview() {
  const d = await api('/api/dashboard/overview');
  document.getElementById('overview-cards').innerHTML = \`
    <div class="card"><div class="label">连接数</div><div class="value">\${d.connectionsCount}</div></div>
    <div class="card"><div class="label">待审批</div><div class="value" style="color:\${d.pendingApprovals > 0 ? 'var(--warn)' : 'var(--text)'}">\${d.pendingApprovals}</div></div>
    <div class="card"><div class="label">24h 调用量</div><div class="value">\${d.auditStats.last24h.total}</div><div class="sub">拒绝 \${d.auditStats.last24h.denied} · 需审批 \${d.auditStats.last24h.needApproval}</div></div>
    <div class="card"><div class="label">主密钥</div><div class="value" style="font-size:1rem">\${d.masterKey.exists ? '✅ 已就绪' : '❌ 缺失'}</div>\${d.masterKey.fingerprint ? '<div class="sub">' + d.masterKey.fingerprint + '</div>' : ''}</div>
  \`;
}

// Approvals
async function loadApprovals() {
  const d = await api('/api/approvals');
  const renderTask = (t, showActions) => \`
    <table style="margin-bottom:1rem"><tbody>
    <tr><td style="width:120px;color:var(--muted)">状态</td><td><span class="badge badge-\${t.status}">\${t.status}</span></td></tr>
    <tr><td style="color:var(--muted)">连接</td><td>\${t.connectionName}</td></tr>
    <tr><td style="color:var(--muted)">类型</td><td>\${t.statementType}</td></tr>
    <tr><td style="color:var(--muted)">触发规则</td><td>\${t.triggerRule}</td></tr>
    <tr><td style="color:var(--muted)">SQL</td><td><div class="sql-code">\${esc(t.sql)}</div></td></tr>
    \${t.modifiedSql ? '<tr><td style="color:var(--muted)">修改后 SQL</td><td><div class="sql-code">' + esc(t.modifiedSql) + '</div></td></tr>' : ''}
    \${t.decisionNote ? '<tr><td style="color:var(--muted)">备注</td><td>' + esc(t.decisionNote) + '</td></tr>' : ''}
    <tr><td style="color:var(--muted)">创建</td><td>\${new Date(t.createdAt).toLocaleString('zh-CN')}</td></tr>
    <tr><td style="color:var(--muted)">过期</td><td>\${new Date(t.expiresAt).toLocaleString('zh-CN')}</td></tr>
    \${showActions ? '<tr><td style="color:var(--muted)">操作</td><td><div class="actions"><button class="btn btn-approve" onclick="approveTask(\\''+t.id+'\\')">✅ 批准</button><button class="btn btn-deny" onclick="denyTask(\\''+t.id+'\\')">❌ 拒绝</button><button class="btn btn-sm" style="background:var(--accent);color:#fff" onclick="showModify(\\''+t.id+'\\',\\''+esc(t.sql).replace(/'/g,"\\\\'").replace(/\\n/g,' ')+'\\')">✏️ 修改后批准</button></div></td></tr>' : ''}
    </tbody></table>\`;

  document.getElementById('pending-list').innerHTML = d.pending.length
    ? d.pending.map(t => renderTask(t, true)).join('')
    : '<div class="empty">✨ 无待审批任务</div>';
  document.getElementById('approval-history').innerHTML = d.history.length
    ? d.history.map(t => renderTask(t, false)).join('')
    : '<div class="empty">暂无历史记录</div>';
}

function esc(s) { if (!s) return ''; return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

async function approveTask(id) {
  await api('/api/approvals/' + id + '/approve', { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' });
  loadApprovals();
}
async function denyTask(id) {
  const note = prompt('拒绝原因（可选）:');
  await api('/api/approvals/' + id + '/deny', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ note: note || undefined }) });
  loadApprovals();
}
function showModify(id, sql) {
  document.getElementById('modal-root').innerHTML = \`<div class="modal-overlay" onclick="if(event.target===this)closeModal()"><div class="modal">
    <h3>修改 SQL 后批准</h3>
    <textarea id="modify-sql" rows="5">\${sql}</textarea>
    <div style="margin-top:1rem">
      <button class="btn btn-approve" onclick="submitModify('\${id}')">批准执行修改后的 SQL</button>
      <button class="btn btn-deny" onclick="closeModal()">取消</button>
    </div>
  </div></div>\`;
}
async function submitModify(id) {
  const sql = document.getElementById('modify-sql').value;
  await api('/api/approvals/' + id + '/approve', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ modifiedSql: sql }) });
  closeModal();
  loadApprovals();
}
function closeModal() { document.getElementById('modal-root').innerHTML = ''; }

// Connections
async function loadConnections() {
  const list = await api('/api/connections');
  if (!list.length) { document.getElementById('connections-list').innerHTML = '<div class="empty">暂无连接</div>'; return; }
  document.getElementById('connections-list').innerHTML = '<table><thead><tr><th>名称</th><th>主机</th><th>用户</th><th>数据库</th><th>策略</th><th>操作</th></tr></thead><tbody>'
    + list.map(c => \`<tr>
      <td><strong>\${esc(c.name)}</strong></td>
      <td>\${c.host}:\${c.port}</td>
      <td>\${esc(c.username)}</td>
      <td>\${c.defaultSchema || '-'}</td>
      <td>\${JSON.parse(c.policy).preset || 'custom'}</td>
      <td><button class="btn btn-sm" style="background:var(--accent);color:#fff" onclick="testConn('\${c.name}')">测试</button>
          <button class="btn btn-sm btn-deny" onclick="deleteConn('\${c.name}')">删除</button></td>
    </tr>\`).join('') + '</tbody></table>';
}
async function testConn(name) {
  const r = await api('/api/connections/' + name + '/test', { method: 'POST' });
  alert(r.ok ? '✅ 连接成功 (' + r.latencyMs + 'ms)' : '❌ ' + r.error);
}
async function deleteConn(name) {
  if (!confirm('确认删除连接 "' + name + '"?')) return;
  await api('/api/connections/' + name, { method: 'DELETE' });
  loadConnections();
}
function showAddConnection() {
  document.getElementById('modal-root').innerHTML = \`<div class="modal-overlay" onclick="if(event.target===this)closeModal()"><div class="modal">
    <h3>新建连接</h3>
    <div style="display:grid;gap:.7rem">
      <input id="nc-name" placeholder="连接名称 (小写字母数字)" style="background:#0f172a;color:var(--text);border:1px solid var(--border);border-radius:6px;padding:.5rem">
      <input id="nc-host" placeholder="MySQL 主机" style="background:#0f172a;color:var(--text);border:1px solid var(--border);border-radius:6px;padding:.5rem">
      <input id="nc-port" placeholder="端口 (3306)" value="3306" style="background:#0f172a;color:var(--text);border:1px solid var(--border);border-radius:6px;padding:.5rem">
      <input id="nc-user" placeholder="用户名" style="background:#0f172a;color:var(--text);border:1px solid var(--border);border-radius:6px;padding:.5rem">
      <input id="nc-pass" type="password" placeholder="密码" style="background:#0f172a;color:var(--text);border:1px solid var(--border);border-radius:6px;padding:.5rem">
      <input id="nc-schema" placeholder="默认数据库 (可选)" style="background:#0f172a;color:var(--text);border:1px solid var(--border);border-radius:6px;padding:.5rem">
    </div>
    <div style="margin-top:1rem">
      <button class="btn btn-approve" onclick="submitNewConn()">创建</button>
      <button class="btn btn-deny" onclick="closeModal()">取消</button>
    </div>
  </div></div>\`;
}
async function submitNewConn() {
  const body = {
    name: document.getElementById('nc-name').value,
    host: document.getElementById('nc-host').value,
    port: Number(document.getElementById('nc-port').value) || 3306,
    username: document.getElementById('nc-user').value,
    password: document.getElementById('nc-pass').value,
    defaultSchema: document.getElementById('nc-schema').value || undefined,
    policy: JSON.stringify({ preset: 'dev-default' }),
  };
  const r = await api('/api/connections', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
  if (r.error) { alert('Error: ' + r.error); return; }
  closeModal();
  loadConnections();
}

// Audit
async function loadAudit() {
  const sql = document.getElementById('audit-sql')?.value || '';
  const decision = document.getElementById('audit-decision')?.value || '';
  const params = new URLSearchParams({ limit: String(LIMIT), offset: String(auditOffset) });
  if (sql) params.set('sql', sql);
  if (decision) params.set('decision', decision);
  const d = await api('/api/audit?' + params);
  if (!d.records || !d.records.length) { document.getElementById('audit-table').innerHTML = '<div class="empty">无审计记录</div>'; return; }
  document.getElementById('audit-table').innerHTML = '<table><thead><tr><th>时间</th><th>工具</th><th>连接</th><th>SQL</th><th>决策</th><th>执行状态</th></tr></thead><tbody>'
    + d.records.map(r => \`<tr>
      <td style="white-space:nowrap">\${new Date(r.created_at).toLocaleString('zh-CN')}</td>
      <td>\${r.tool_name}</td>
      <td>\${r.connection_name || '-'}</td>
      <td><div class="sql-code" style="max-height:50px">\${esc(r.sql || '-')}</div></td>
      <td><span class="badge badge-\${r.decision}">\${r.decision}</span></td>
      <td>\${r.exec_status || '-'}</td>
    </tr>\`).join('') + '</tbody></table>';

  const pages = Math.ceil(d.total / LIMIT);
  document.getElementById('audit-pagination').innerHTML =
    '<button ' + (auditOffset <= 0 ? 'disabled' : '') + ' onclick="auditOffset-=LIMIT;loadAudit()">上一页</button>' +
    '<span style="color:var(--muted);font-size:.85rem;padding:.3rem">第 ' + (Math.floor(auditOffset/LIMIT)+1) + '/' + pages + ' 页 (共' + d.total + '条)</span>' +
    '<button ' + (auditOffset + LIMIT >= d.total ? 'disabled' : '') + ' onclick="auditOffset+=LIMIT;loadAudit()">下一页</button>';
}

// Auto-refresh approvals every 5s
setInterval(() => {
  if (document.getElementById('tab-approvals').classList.contains('active')) loadApprovals();
}, 5000);

// Initial load
loadOverview();

// Check for approve query param
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('approve')) {
  showTab('approvals');
}
</script>
</body>
</html>`;
