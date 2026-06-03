import type BetterSqlite3 from "better-sqlite3";
import { decryptSecret, encryptSecret } from "./crypto.js";

/** Connection name validation: lowercase alphanumeric, hyphens, underscores, 1-64 chars */
export const CONNECTION_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface ConnectionInput {
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  defaultSchema?: string | undefined;
  policy: string;
}

export interface Connection {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  /** Decrypted password — only available when explicitly requested */
  password: string;
  defaultSchema?: string | undefined;
  policy: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string | undefined;
}

/** Connection info without password (safe for listing) */
export interface ConnectionInfo {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  defaultSchema?: string | undefined;
  policy: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string | undefined;
}

function stripPassword(conn: Connection): ConnectionInfo {
  const { password: _, ...info } = conn;
  return info;
}

/** Validate connection name format */
export function validateConnectionName(name: string): string | true {
  if (!name) return "Connection name is required";
  if (name.length > 64) return "Connection name must be 64 characters or less";
  if (!CONNECTION_NAME_RE.test(name)) {
    return "Connection name must start with a lowercase letter or digit, and contain only lowercase letters, digits, hyphens, and underscores";
  }
  return true;
}

/** Create a new connection with encrypted password */
export function createConnection(
  db: BetterSqlite3.Database,
  input: ConnectionInput,
  masterKey: Buffer,
): ConnectionInfo {
  const nameValidation = validateConnectionName(input.name);
  if (nameValidation !== true) throw new Error(nameValidation as string);

  // Check for duplicate
  const existing = db
    .prepare("SELECT id FROM connections WHERE name = ?")
    .get(input.name);
  if (existing) throw new Error(`Connection "${input.name}" already exists`);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const passwordEnc = encryptSecret(input.password, masterKey);

  db.prepare(
    `
    INSERT INTO connections (id, name, host, port, username, password_enc, default_schema, policy, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    id,
    input.name,
    input.host,
    input.port,
    input.username,
    passwordEnc,
    input.defaultSchema ?? null,
    input.policy,
    now,
    now,
  );

  return {
    id,
    name: input.name,
    host: input.host,
    port: input.port,
    username: input.username,
    defaultSchema: input.defaultSchema,
    policy: input.policy,
    createdAt: now,
    updatedAt: now,
  };
}

/** Get a connection by name, with decrypted password */
export function getConnection(
  db: BetterSqlite3.Database,
  name: string,
  masterKey: Buffer,
): Connection {
  const row = db
    .prepare("SELECT * FROM connections WHERE name = ?")
    .get(name) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`Connection "${name}" not found`);

  return {
    id: row.id as string,
    name: row.name as string,
    host: row.host as string,
    port: row.port as number,
    username: row.username as string,
    password: decryptSecret(row.password_enc as string, masterKey),
    defaultSchema: (row.default_schema as string | null) ?? undefined,
    policy: row.policy as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    lastUsedAt: (row.last_used_at as string | null) ?? undefined,
  };
}

/** List all connections without passwords */
export function listConnections(db: BetterSqlite3.Database): ConnectionInfo[] {
  const rows = db
    .prepare("SELECT * FROM connections ORDER BY name")
    .all() as Record<string, unknown>[];
  return rows.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    host: row.host as string,
    port: row.port as number,
    username: row.username as string,
    defaultSchema: (row.default_schema as string | null) ?? undefined,
    policy: row.policy as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    lastUsedAt: (row.last_used_at as string | null) ?? undefined,
  }));
}

/** Update a connection by name */
export function updateConnection(
  db: BetterSqlite3.Database,
  name: string,
  patch: Partial<Omit<ConnectionInput, "name">>,
  masterKey: Buffer,
): ConnectionInfo {
  const existing = getConnection(db, name, masterKey);

  const updates: string[] = [];
  const values: unknown[] = [];

  if (patch.host !== undefined) {
    updates.push("host = ?");
    values.push(patch.host);
  }
  if (patch.port !== undefined) {
    updates.push("port = ?");
    values.push(patch.port);
  }
  if (patch.username !== undefined) {
    updates.push("username = ?");
    values.push(patch.username);
  }
  if (patch.password !== undefined) {
    updates.push("password_enc = ?");
    values.push(encryptSecret(patch.password, masterKey));
  }
  if (patch.defaultSchema !== undefined) {
    updates.push("default_schema = ?");
    values.push(patch.defaultSchema);
  }
  if (patch.policy !== undefined) {
    updates.push("policy = ?");
    values.push(patch.policy);
  }

  if (updates.length === 0) return stripPassword(existing);

  updates.push("updated_at = ?");
  values.push(new Date().toISOString());
  values.push(name);

  db.prepare(`UPDATE connections SET ${updates.join(", ")} WHERE name = ?`).run(
    ...values,
  );

  // Return updated info (without password)
  const updated = db
    .prepare("SELECT * FROM connections WHERE name = ?")
    .get(name) as Record<string, unknown>;
  return {
    id: updated.id as string,
    name: updated.name as string,
    host: updated.host as string,
    port: updated.port as number,
    username: updated.username as string,
    defaultSchema: (updated.default_schema as string | null) ?? undefined,
    policy: updated.policy as string,
    createdAt: updated.created_at as string,
    updatedAt: updated.updated_at as string,
    lastUsedAt: (updated.last_used_at as string | null) ?? undefined,
  };
}

/** Delete a connection by name */
export function deleteConnection(
  db: BetterSqlite3.Database,
  name: string,
): void {
  const result = db.prepare("DELETE FROM connections WHERE name = ?").run(name);
  if (result.changes === 0) throw new Error(`Connection "${name}" not found`);
}
