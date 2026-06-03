/**
 * Unit tests for Dashboard token authentication.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearSessions, createAuthMiddleware } from "../../../src/web/auth.js";

const cleanupQueue: string[] = [];
afterEach(() => {
  for (const dir of cleanupQueue) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  cleanupQueue.length = 0;
  clearSessions();
});

function createTokenFile(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xizhao-auth-"));
  cleanupQueue.push(tmpDir);
  const tokenPath = path.join(tmpDir, "dashboard.token");
  fs.writeFileSync(tokenPath, "test-token-12345");
  return tokenPath;
}

describe("auth middleware", () => {
  let tokenPath: string;
  beforeEach(() => {
    tokenPath = createTokenFile();
  });

  it("returns 401 for API routes without auth", async () => {
    const middleware = createAuthMiddleware(tokenPath);
    const c = {
      req: {
        header: () => undefined,
        query: () => undefined,
        path: "/api/approvals",
      },
      json: (body: unknown, status: number) =>
        new Response(JSON.stringify(body), { status }),
      html: () => new Response("html", { status: 401 }),
    } as never;

    let nextCalled = false;
    await middleware(c, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(false);
  });

  it("allows API routes with valid Bearer token", async () => {
    const middleware = createAuthMiddleware(tokenPath);
    const c = {
      req: {
        header: (name: string) =>
          name === "authorization" ? "Bearer test-token-12345" : undefined,
        query: () => undefined,
        path: "/api/approvals",
      },
    } as never;

    let nextCalled = false;
    await middleware(c, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
  });

  it("rejects invalid Bearer token", async () => {
    const middleware = createAuthMiddleware(tokenPath);
    const c = {
      req: {
        header: (name: string) =>
          name === "authorization" ? "Bearer wrong-token" : undefined,
        query: () => undefined,
        path: "/api/approvals",
      },
      json: (body: unknown, status: number) =>
        new Response(JSON.stringify(body), { status }),
      html: () => new Response("html", { status: 401 }),
    } as never;

    let nextCalled = false;
    await middleware(c, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(false);
  });

  it("redirects to set cookie on valid query token", async () => {
    const middleware = createAuthMiddleware(tokenPath);
    const c = {
      req: {
        header: () => undefined,
        query: (name: string) =>
          name === "token" ? "test-token-12345" : undefined,
        path: "/",
      },
    } as never;

    const result = (await middleware(c, async () => {})) as Response;

    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(302);
    const cookie = result.headers.get("Set-Cookie");
    expect(cookie).toContain("xizhao_session=");
    expect(cookie).toContain("HttpOnly");
  });

  it("allows request with valid session cookie", async () => {
    const middleware = createAuthMiddleware(tokenPath);

    // First: get a session via token
    const c1 = {
      req: {
        header: () => undefined,
        query: (name: string) =>
          name === "token" ? "test-token-12345" : undefined,
        path: "/",
      },
    } as never;

    const redirect = (await middleware(c1, async () => {})) as Response;
    const cookieHeader = redirect.headers.get("Set-Cookie") ?? "";
    const sessionMatch = cookieHeader.match(/xizhao_session=([^;]+)/);
    const sessionId = sessionMatch?.[1];
    expect(sessionId).toBeTruthy();

    // Second: use the session cookie
    const c2 = {
      req: {
        header: (name: string) =>
          name === "cookie" ? `xizhao_session=${sessionId}` : undefined,
        query: () => undefined,
        path: "/api/approvals",
      },
    } as never;

    let nextCalled = false;
    await middleware(c2, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
  });
});
