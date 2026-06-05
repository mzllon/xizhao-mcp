/**
 * Jupyter-style token authentication for the Dashboard.
 *
 * Flow:
 *   1. First access must include `?token=xxx` query parameter
 *   2. On valid token → set HttpOnly cookie `xm_sql_mcp_session`
 *   3. Subsequent requests validated via cookie
 *   4. No cookie and no token → return 401 with token input page
 *
 * Sessions are stored in-memory (sufficient for single-user local tool).
 */
import type { MiddlewareHandler } from "hono";
import crypto from "node:crypto";
import fs from "node:fs";

/** Active sessions: sessionCookie → true */
const sessions = new Set<string>();

/** Generate a new session cookie value */
function createSession(): string {
  const value = crypto.randomBytes(32).toString("base64url");
  sessions.add(value);
  return value;
}

/** Validate a session cookie value */
function isValidSession(value: string): boolean {
  return sessions.has(value);
}

/** Clear all sessions (for testing) */
export function clearSessions(): void {
  sessions.clear();
}

/** Minimal token input page */
const tokenInputPage = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>XM Dashboard - 认证</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
  .card { background: #16213e; padding: 2rem; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.3); max-width: 400px; width: 100%; }
  h1 { margin: 0 0 0.5rem; font-size: 1.5rem; }
  p { color: #aaa; margin: 0 0 1.5rem; font-size: 0.9rem; }
  input { width: 100%; padding: 0.75rem; border: 1px solid #333; border-radius: 8px; background: #0f3460; color: #eee; font-size: 1rem; box-sizing: border-box; }
  button { width: 100%; padding: 0.75rem; margin-top: 1rem; border: none; border-radius: 8px; background: #e94560; color: white; font-size: 1rem; cursor: pointer; }
  button:hover { background: #c73a52; }
</style>
</head>
<body>
<div class="card">
  <h1>🔐 XM Dashboard</h1>
  <p>请输入启动时生成的 Token</p>
  <input id="token" type="text" placeholder="粘贴 Token..." autofocus>
  <button onclick="submit()">登录</button>
</div>
<script>
function submit() {
  const token = document.getElementById('token').value.trim();
  if (token) window.location.href = '/?token=' + encodeURIComponent(token);
}
document.getElementById('token').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
</script>
</body>
</html>`;

/**
 * Create the auth middleware.
 * Reads the expected token from the given file path.
 */
export function createAuthMiddleware(tokenPath: string): MiddlewareHandler {
  // Read token once at middleware creation time
  const expectedToken = fs.readFileSync(tokenPath, "utf-8").trim();

  return async (c, next) => {
    // Check cookie first
    const cookie = c.req.header("cookie") ?? "";
    const sessionMatch = cookie.match(/xm_sql_mcp_session=([^;]+)/);
    if (sessionMatch?.[1] && isValidSession(sessionMatch[1])) {
      return next();
    }

    // Check query param token
    const queryToken = c.req.query("token");
    if (queryToken === expectedToken) {
      // Valid first-access — create session and set cookie
      const session = createSession();
      return new Response(null, {
        status: 302,
        headers: {
          Location: c.req.path,
          "Set-Cookie": `xm_sql_mcp_session=${session}; HttpOnly; SameSite=Strict; Path=/`,
        },
      });
    }

    // Check Authorization header (for API calls)
    const authHeader = c.req.header("authorization");
    if (authHeader === `Bearer ${expectedToken}`) {
      return next();
    }

    // No valid auth
    if (c.req.path.startsWith("/api/")) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // For non-API paths, return token input page
    return c.html(tokenInputPage, 401);
  };
}

/** Validate token without creating a session (for API-only auth) */
export function validateToken(token: string, tokenPath: string): boolean {
  const expected = fs.readFileSync(tokenPath, "utf-8").trim();
  return token === expected;
}
