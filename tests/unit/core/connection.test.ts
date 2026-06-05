import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createConnection,
  deleteConnection,
  getConnection,
  listConnections,
  updateConnection,
  validateConnectionName,
} from "../../../src/core/connection.js";
import { openStorage } from "../../../src/core/storage.js";

const cleanupQueue: string[] = [];

afterEach(() => {
  for (const dir of cleanupQueue) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows WAL lock
    }
  }
  cleanupQueue.length = 0;
});

function setup() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xm-sql-mcp-conn-"));
  cleanupQueue.push(tmpDir);
  const { raw, close } = openStorage(tmpDir);
  const masterKey = crypto.randomBytes(32);
  return { raw, masterKey, close };
}

const defaultInput = {
  name: "dev-db",
  host: "127.0.0.1",
  port: 3306,
  username: "root",
  password: "secret123",
  policy: JSON.stringify({ preset: "dev-default" }),
};

describe("connection", () => {
  describe("validateConnectionName", () => {
    it("accepts valid names", () => {
      expect(validateConnectionName("dev-db")).toBe(true);
      expect(validateConnectionName("mydb")).toBe(true);
      expect(validateConnectionName("db1_test")).toBe(true);
      expect(validateConnectionName("a")).toBe(true);
    });

    it("rejects empty name", () => {
      expect(validateConnectionName("")).not.toBe(true);
    });

    it("rejects uppercase", () => {
      expect(validateConnectionName("Dev-DB")).not.toBe(true);
    });

    it("rejects spaces", () => {
      expect(validateConnectionName("my db")).not.toBe(true);
    });

    it("rejects names starting with hyphen", () => {
      expect(validateConnectionName("-db")).not.toBe(true);
    });

    it("rejects names over 64 chars", () => {
      expect(validateConnectionName("a".repeat(65))).not.toBe(true);
    });
  });

  describe("createConnection", () => {
    it("creates a connection and stores encrypted password", () => {
      const { raw, masterKey, close } = setup();
      try {
        const info = createConnection(raw, defaultInput, masterKey);
        expect(info.name).toBe("dev-db");
        expect(info.host).toBe("127.0.0.1");
        expect(info.id).toBeTruthy();

        // Verify encrypted in DB
        const row = raw
          .prepare("SELECT password_enc FROM connections WHERE name = ?")
          .get("dev-db") as { password_enc: string };
        expect(row.password_enc).not.toBe("secret123");

        // Verify decryption works
        const conn = getConnection(raw, "dev-db", masterKey);
        expect(conn.password).toBe("secret123");
      } finally {
        close();
      }
    });

    it("rejects duplicate name", () => {
      const { raw, masterKey, close } = setup();
      try {
        createConnection(raw, defaultInput, masterKey);
        expect(() => createConnection(raw, defaultInput, masterKey)).toThrow(
          "already exists",
        );
      } finally {
        close();
      }
    });

    it("rejects invalid name", () => {
      const { raw, masterKey, close } = setup();
      try {
        expect(() =>
          createConnection(raw, { ...defaultInput, name: "BAD" }, masterKey),
        ).toThrow();
      } finally {
        close();
      }
    });

    it("stores description when provided", () => {
      const { raw, masterKey, close } = setup();
      try {
        const info = createConnection(
          raw,
          { ...defaultInput, description: "项目A开发库" },
          masterKey,
        );
        expect(info.description).toBe("项目A开发库");
        const conn = getConnection(raw, "dev-db", masterKey);
        expect(conn.description).toBe("项目A开发库");
      } finally {
        close();
      }
    });

    it("stores undefined description as null", () => {
      const { raw, masterKey, close } = setup();
      try {
        const info = createConnection(raw, defaultInput, masterKey);
        expect(info.description).toBeUndefined();
        const row = raw
          .prepare("SELECT description FROM connections WHERE name = ?")
          .get("dev-db") as { description: string | null };
        expect(row.description).toBeNull();
      } finally {
        close();
      }
    });
  });

  describe("getConnection", () => {
    it("returns connection with decrypted password", () => {
      const { raw, masterKey, close } = setup();
      try {
        createConnection(raw, defaultInput, masterKey);
        const conn = getConnection(raw, "dev-db", masterKey);
        expect(conn.name).toBe("dev-db");
        expect(conn.password).toBe("secret123");
        expect(conn.port).toBe(3306);
      } finally {
        close();
      }
    });

    it("throws for non-existent connection", () => {
      const { raw, masterKey, close } = setup();
      try {
        expect(() => getConnection(raw, "missing", masterKey)).toThrow(
          "not found",
        );
      } finally {
        close();
      }
    });
  });

  describe("listConnections", () => {
    it("returns empty list initially", () => {
      const { raw, close } = setup();
      try {
        const list = listConnections(raw);
        expect(list).toEqual([]);
      } finally {
        close();
      }
    });

    it("returns all connections sorted by name", () => {
      const { raw, masterKey, close } = setup();
      try {
        createConnection(raw, { ...defaultInput, name: "alpha" }, masterKey);
        createConnection(raw, { ...defaultInput, name: "beta" }, masterKey);
        const list = listConnections(raw);
        expect(list.map((c) => c.name)).toEqual(["alpha", "beta"]);
        // Should not contain password
        expect("password" in list[0]).toBe(false);
      } finally {
        close();
      }
    });

    it("includes description in listing", () => {
      const { raw, masterKey, close } = setup();
      try {
        createConnection(
          raw,
          { ...defaultInput, description: "项目A开发库" },
          masterKey,
        );
        const list = listConnections(raw);
        expect(list[0].description).toBe("项目A开发库");
      } finally {
        close();
      }
    });

    it("includes undefined description when not set", () => {
      const { raw, masterKey, close } = setup();
      try {
        createConnection(raw, defaultInput, masterKey);
        const list = listConnections(raw);
        expect(list[0].description).toBeUndefined();
      } finally {
        close();
      }
    });
  });

  describe("updateConnection", () => {
    it("updates host and port", () => {
      const { raw, masterKey, close } = setup();
      try {
        createConnection(raw, defaultInput, masterKey);
        const updated = updateConnection(
          raw,
          "dev-db",
          { host: "10.0.0.1", port: 3307 },
          masterKey,
        );
        expect(updated.host).toBe("10.0.0.1");
        expect(updated.port).toBe(3307);
      } finally {
        close();
      }
    });

    it("re-encrypts password on update", () => {
      const { raw, masterKey, close } = setup();
      try {
        createConnection(raw, defaultInput, masterKey);
        updateConnection(raw, "dev-db", { password: "new-secret" }, masterKey);
        const conn = getConnection(raw, "dev-db", masterKey);
        expect(conn.password).toBe("new-secret");
      } finally {
        close();
      }
    });

    it("no-op when patch is empty", () => {
      const { raw, masterKey, close } = setup();
      try {
        const info = createConnection(raw, defaultInput, masterKey);
        const updated = updateConnection(raw, "dev-db", {}, masterKey);
        expect(updated.host).toBe(info.host);
      } finally {
        close();
      }
    });

    it("updates description", () => {
      const { raw, masterKey, close } = setup();
      try {
        createConnection(raw, defaultInput, masterKey);
        const updated = updateConnection(
          raw,
          "dev-db",
          { description: "新的描述" },
          masterKey,
        );
        expect(updated.description).toBe("新的描述");
        const conn = getConnection(raw, "dev-db", masterKey);
        expect(conn.description).toBe("新的描述");
      } finally {
        close();
      }
    });

    it("clears description with empty string", () => {
      const { raw, masterKey, close } = setup();
      try {
        createConnection(
          raw,
          { ...defaultInput, description: "项目A开发库" },
          masterKey,
        );
        const updated = updateConnection(
          raw,
          "dev-db",
          { description: "" },
          masterKey,
        );
        expect(updated.description).toBeUndefined();
      } finally {
        close();
      }
    });
  });

  describe("deleteConnection", () => {
    it("deletes existing connection", () => {
      const { raw, masterKey, close } = setup();
      try {
        createConnection(raw, defaultInput, masterKey);
        deleteConnection(raw, "dev-db");
        expect(listConnections(raw)).toEqual([]);
      } finally {
        close();
      }
    });

    it("throws for non-existent connection", () => {
      const { raw, close } = setup();
      try {
        expect(() => deleteConnection(raw, "missing")).toThrow("not found");
      } finally {
        close();
      }
    });
  });
});
