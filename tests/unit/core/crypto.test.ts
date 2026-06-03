import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  getKeyFingerprint,
  loadOrCreateMasterKey,
} from "../../../src/core/crypto.js";

describe("crypto", () => {
  const masterKey = crypto.randomBytes(32);

  describe("encryptSecret / decryptSecret round-trip", () => {
    it("encrypts and decrypts back to original plaintext", () => {
      const plaintext = "my-super-secret-password";
      const encrypted = encryptSecret(plaintext, masterKey);
      const decrypted = decryptSecret(encrypted, masterKey);
      expect(decrypted).toBe(plaintext);
    });

    it("produces different ciphertext for same plaintext (random IV)", () => {
      const plaintext = "same-password";
      const enc1 = encryptSecret(plaintext, masterKey);
      const enc2 = encryptSecret(plaintext, masterKey);
      expect(enc1).not.toBe(enc2);
    });

    it("handles empty string", () => {
      const plaintext = "";
      const encrypted = encryptSecret(plaintext, masterKey);
      const decrypted = decryptSecret(encrypted, masterKey);
      expect(decrypted).toBe("");
    });

    it("handles unicode characters", () => {
      const plaintext = "密码パスワード🔐";
      const encrypted = encryptSecret(plaintext, masterKey);
      const decrypted = decryptSecret(encrypted, masterKey);
      expect(decrypted).toBe(plaintext);
    });

    it("handles long strings", () => {
      const plaintext = "x".repeat(10_000);
      const encrypted = encryptSecret(plaintext, masterKey);
      const decrypted = decryptSecret(encrypted, masterKey);
      expect(decrypted).toBe(plaintext);
    });
  });

  describe("decryptSecret error handling", () => {
    it("throws on tampered ciphertext", () => {
      const encrypted = encryptSecret("test", masterKey);
      // Decode, tamper 1 byte, re-encode
      const buf = Buffer.from(encrypted, "base64");
      buf[buf.length - 1] ^= 0xff;
      const tampered = buf.toString("base64");
      expect(() => decryptSecret(tampered, masterKey)).toThrow(
        "DECRYPT_FAILED",
      );
    });

    it("throws on wrong key", () => {
      const encrypted = encryptSecret("test", masterKey);
      const wrongKey = crypto.randomBytes(32);
      expect(() => decryptSecret(encrypted, wrongKey)).toThrow(
        "DECRYPT_FAILED",
      );
    });

    it("throws on payload too short", () => {
      const short = Buffer.alloc(10).toString("base64");
      expect(() => decryptSecret(short, masterKey)).toThrow("DECRYPT_FAILED");
    });

    it("throws on invalid base64", () => {
      expect(() => decryptSecret("!!!not-base64!!!", masterKey)).toThrow();
    });
  });

  describe("getKeyFingerprint", () => {
    it("returns 8-char hex string", () => {
      const fp = getKeyFingerprint(masterKey);
      expect(fp).toMatch(/^[0-9a-f]{8}$/);
    });

    it("returns consistent fingerprint for same key", () => {
      expect(getKeyFingerprint(masterKey)).toBe(getKeyFingerprint(masterKey));
    });

    it("returns different fingerprint for different keys", () => {
      const otherKey = crypto.randomBytes(32);
      expect(getKeyFingerprint(masterKey)).not.toBe(
        getKeyFingerprint(otherKey),
      );
    });
  });

  describe("loadOrCreateMasterKey", () => {
    it("creates a new key if file does not exist", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xizhao-test-"));
      try {
        const key = loadOrCreateMasterKey(tmpDir);
        expect(key).toBeInstanceOf(Buffer);
        expect(key.length).toBe(32);
        expect(fs.existsSync(path.join(tmpDir, "master.key"))).toBe(true);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("loads existing key", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xizhao-test-"));
      try {
        const key1 = loadOrCreateMasterKey(tmpDir);
        const key2 = loadOrCreateMasterKey(tmpDir);
        expect(key1.equals(key2)).toBe(true);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("throws on corrupt key (wrong length)", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xizhao-test-"));
      try {
        fs.writeFileSync(path.join(tmpDir, "master.key"), Buffer.alloc(16));
        expect(() => loadOrCreateMasterKey(tmpDir)).toThrow(
          "MASTER_KEY_CORRUPT",
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("respects XIZHAO_MASTER_KEY_FILE env var", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xizhao-test-"));
      const customPath = path.join(tmpDir, "custom.key");
      const origEnv = process.env.XIZHAO_MASTER_KEY_FILE;
      try {
        process.env.XIZHAO_MASTER_KEY_FILE = customPath;
        const key = loadOrCreateMasterKey(tmpDir);
        expect(key.length).toBe(32);
        expect(fs.existsSync(customPath)).toBe(true);
      } finally {
        if (origEnv !== undefined) {
          process.env.XIZHAO_MASTER_KEY_FILE = origEnv;
        } else {
          delete process.env.XIZHAO_MASTER_KEY_FILE;
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
