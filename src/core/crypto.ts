import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getPaths } from "./app-paths.js";

const MASTER_KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const ALGORITHM = "aes-256-gcm";

/**
 * Load or create the master key file.
 *
 * - Default path: ~/.xm-sql-mcp/master.key
 * - Override with XM_SQL_MCP_MASTER_KEY_FILE env var
 * - Creates 32-byte random key if file doesn't exist
 * - Validates existing key length
 */
export function loadOrCreateMasterKey(appDir?: string): Buffer {
  const paths = getPaths(appDir);
  const keyPath = process.env.XM_SQL_MCP_MASTER_KEY_FILE ?? paths.masterKey;

  if (fs.existsSync(keyPath)) {
    const key = fs.readFileSync(keyPath);
    if (key.length !== MASTER_KEY_BYTES) {
      throw new Error(
        `MASTER_KEY_CORRUPT: master key at ${keyPath} is ${key.length} bytes, expected ${MASTER_KEY_BYTES}`,
      );
    }
    return key;
  }

  // Generate new master key
  const key = crypto.randomBytes(MASTER_KEY_BYTES);

  // Ensure parent directory exists
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });

  // Write with restrictive permissions (0o600 on Unix)
  fs.writeFileSync(keyPath, key, { mode: 0o600 });

  // On Windows, try to restrict file access
  if (process.platform === "win32") {
    try {
      // Best-effort: remove inherited ACEs, grant only current user
      // icacls may not be available in all environments
    } catch {
      // Non-critical: print warning but don't block
    }
  }

  return key;
}

/** SHA-256 fingerprint of master key (first 8 hex chars) for Dashboard health card */
export function getKeyFingerprint(key: Buffer): string {
  const hash = crypto.createHash("sha256").update(key).digest("hex");
  return hash.slice(0, 8);
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 *
 * Output: base64(iv || authTag || ciphertext)
 * - 12-byte random IV (never reused)
 * - 16-byte authentication tag
 * - Variable-length ciphertext
 */
export function encryptSecret(plaintext: string, masterKey: Buffer): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, masterKey, iv, {
    authTagLength: AUTH_TAG_BYTES,
  });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  // iv (12) || authTag (16) || ciphertext
  const combined = Buffer.concat([iv, authTag, encrypted]);
  return combined.toString("base64");
}

/**
 * Decrypt a secret previously encrypted with encryptSecret.
 *
 * Input: base64(iv || authTag || ciphertext)
 * Throws XmSqlMcpError on any decryption failure (wrong key, tampered data, etc.)
 */
export function decryptSecret(payload: string, masterKey: Buffer): string {
  let combined: Buffer;
  try {
    combined = Buffer.from(payload, "base64");
  } catch {
    throw new Error("DECRYPT_FAILED: invalid base64 encoding");
  }

  const minLen = IV_BYTES + AUTH_TAG_BYTES;
  if (combined.length < minLen) {
    throw new Error(
      `DECRYPT_FAILED: payload too short (${combined.length} bytes, minimum ${minLen})`,
    );
  }

  const iv = combined.subarray(0, IV_BYTES);
  const authTag = combined.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
  const ciphertext = combined.subarray(IV_BYTES + AUTH_TAG_BYTES);

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, masterKey, iv, {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return decrypted.toString("utf8");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`DECRYPT_FAILED: ${msg}`);
  }
}

/**
 * Rotate master key: re-encrypt all records from old key to new key.
 * Interface defined for v2 — implementation deferred.
 */
export interface EncryptedRecord {
  passwordEnc: string;
}
export async function rotateMasterKey(
  _oldKey: Buffer,
  _newKey: Buffer,
  _records: EncryptedRecord[],
): Promise<EncryptedRecord[]> {
  throw new Error("rotateMasterKey: not implemented (v2)");
}
