import type { PoolClient } from "pg";
import type { TenantClient } from "./client.js";

export interface AuthenticatedSession {
  sessionId: string;
  tenantId: string;
  userId: string;
  role: string;
  locale: string;
  mfaEnabled: boolean;
}

export interface AuthenticatedKey {
  keyId: string;
  tenantId: string;
  scopes: string[];
  environment: "live" | "test";
}

export interface LoginCandidate {
  userId: string;
  tenantId: string;
  passwordHash: string | null;
  totpSecret: string | null;
  role: string;
  locale: string;
  mfaEnabled: boolean;
  lockedUntil: Date | null;
}

/**
 * Resolves a session token hash to its tenant.
 *
 * Expiry and revocation are enforced inside the SQL function, not here, so a
 * forgotten condition in application code cannot resurrect a dead session.
 */
export async function authenticateSession(
  client: PoolClient,
  tokenHash: string,
): Promise<AuthenticatedSession | undefined> {
  const { rows } = await client.query<{
    session_id: string;
    tenant_id: string;
    user_id: string;
    role: string;
    locale: string;
    mfa_enabled: boolean;
  }>("SELECT * FROM authenticate_session($1)", [tokenHash]);

  const row = rows[0];
  return row
    ? {
        sessionId: row.session_id,
        tenantId: row.tenant_id,
        userId: row.user_id,
        role: row.role,
        locale: row.locale,
        mfaEnabled: row.mfa_enabled,
      }
    : undefined;
}

export async function authenticateApiKey(
  client: PoolClient,
  tokenHash: string,
): Promise<AuthenticatedKey | undefined> {
  const { rows } = await client.query<{
    key_id: string;
    tenant_id: string;
    scopes: string[];
    environment: "live" | "test";
  }>("SELECT * FROM authenticate_api_key($1)", [tokenHash]);

  const row = rows[0];
  return row
    ? {
        keyId: row.key_id,
        tenantId: row.tenant_id,
        scopes: row.scopes ?? [],
        environment: row.environment,
      }
    : undefined;
}

export async function touchSession(client: PoolClient, sessionId: string): Promise<void> {
  await client.query("SELECT touch_session($1)", [sessionId]);
}

export async function findUserForLogin(
  client: PoolClient,
  email: string,
): Promise<LoginCandidate | undefined> {
  const { rows } = await client.query<{
    user_id: string;
    tenant_id: string;
    password_hash: string | null;
    totp_secret: string | null;
    role: string;
    locale: string;
    mfa_enabled: boolean;
    locked_until: Date | null;
  }>("SELECT * FROM find_user_for_login($1)", [email]);

  const row = rows[0];
  return row
    ? {
        userId: row.user_id,
        tenantId: row.tenant_id,
        passwordHash: row.password_hash,
        totpSecret: row.totp_secret,
        role: row.role,
        locale: row.locale,
        mfaEnabled: row.mfa_enabled,
        lockedUntil: row.locked_until,
      }
    : undefined;
}

export async function recordLoginAttempt(
  client: PoolClient,
  userId: string,
  success: boolean,
  maxFailures = 10,
  lockMinutes = 15,
): Promise<void> {
  await client.query("SELECT record_login_attempt($1, $2, $3, $4)", [
    userId,
    success,
    maxFailures,
    lockMinutes,
  ]);
}

export interface CreateSessionInput {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  ip?: string | null;
  userAgent?: string | null;
}

export async function createSession(
  tx: TenantClient,
  input: CreateSessionInput,
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO sessions (tenant_id, user_id, token_hash, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      tx.tenantId,
      input.userId,
      input.tokenHash,
      input.expiresAt.toISOString(),
      input.ip ?? null,
      input.userAgent ?? null,
    ],
  );
  return rows[0]?.id as string;
}

export async function revokeSession(tx: TenantClient, sessionId: string): Promise<void> {
  await tx.query(
    "UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL",
    [sessionId],
  );
}

/** Signing out everywhere, and what a password change must do. */
export async function revokeAllSessions(tx: TenantClient, userId: string): Promise<number> {
  const { rowCount } = await tx.query(
    "UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
    [userId],
  );
  return rowCount ?? 0;
}

export interface CreateUserInput {
  email: string;
  role: string;
  passwordHash: string;
  locale?: string;
  totpSecret?: string | null;
  mfaEnabled?: boolean;
}

export async function createUser(tx: TenantClient, input: CreateUserInput): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO users (tenant_id, email, role, locale, password_hash, totp_secret, mfa_enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      tx.tenantId,
      input.email,
      input.role,
      input.locale ?? "de",
      input.passwordHash,
      input.totpSecret ?? null,
      input.mfaEnabled ?? false,
    ],
  );
  return rows[0]?.id as string;
}

export async function setTotpSecret(
  tx: TenantClient,
  userId: string,
  secret: string | null,
  enabled: boolean,
): Promise<void> {
  await tx.query(
    "UPDATE users SET totp_secret = $2, mfa_enabled = $3 WHERE id = $1",
    [userId, secret, enabled],
  );
}

export interface CreateApiKeyInput {
  name: string;
  environment: "live" | "test";
  prefix: string;
  tokenHash: string;
  scopes: string[];
  createdBy?: string | null;
  expiresAt?: Date | null;
}

export async function createApiKey(tx: TenantClient, input: CreateApiKeyInput): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO api_keys (tenant_id, name, environment, prefix, token_hash, scopes, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      tx.tenantId,
      input.name,
      input.environment,
      input.prefix,
      input.tokenHash,
      input.scopes,
      input.createdBy ?? null,
      input.expiresAt?.toISOString() ?? null,
    ],
  );
  return rows[0]?.id as string;
}

/**
 * Claims one TOTP time step for one user.
 *
 * Returns false when the step was already used, which makes a code observed
 * inside its 30-second window useless to whoever observed it. Atomic, so two
 * concurrent uses of one code cannot both win.
 */
export async function consumeTotp(
  client: PoolClient,
  userId: string,
  counter: number,
): Promise<boolean> {
  const { rows } = await client.query<{ consume_totp: boolean }>(
    "SELECT consume_totp($1, $2)",
    [userId, counter],
  );
  return rows[0]?.consume_totp === true;
}
