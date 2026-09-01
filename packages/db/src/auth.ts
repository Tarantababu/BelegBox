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

export interface ResetClaim {
  userId: string;
  tenantId: string;
  role: string;
  totpSecret: string | null;
  mfaEnabled: boolean;
}

export async function issuePasswordReset(
  client: PoolClient,
  userId: string,
  tokenHash: string,
  expiresAt: Date,
  ip?: string | null,
): Promise<string> {
  const { rows } = await client.query<{ issue_password_reset: string }>(
    "SELECT issue_password_reset($1, $2, $3, $4)",
    [userId, tokenHash, expiresAt.toISOString(), ip ?? null],
  );
  return rows[0]?.issue_password_reset as string;
}

/**
 * Reads a reset token without spending it.
 *
 * The second factor is verified before the token is claimed, so a mistyped code
 * does not cost the user their one link.
 */
export async function findPasswordReset(
  client: PoolClient,
  tokenHash: string,
): Promise<ResetClaim | undefined> {
  const { rows } = await client.query<{
    user_id: string;
    tenant_id: string;
    role: string;
    totp_secret: string | null;
    mfa_enabled: boolean;
  }>("SELECT * FROM find_password_reset($1)", [tokenHash]);

  const row = rows[0];
  return row
    ? {
        userId: row.user_id,
        tenantId: row.tenant_id,
        role: row.role,
        totpSecret: row.totp_secret,
        mfaEnabled: row.mfa_enabled,
      }
    : undefined;
}

/**
 * Claims a reset token, marking it used in the same statement.
 *
 * Returns nothing for a token that is unknown, expired or already spent - three
 * cases the caller must not be able to tell apart.
 */
export async function claimPasswordReset(
  client: PoolClient,
  tokenHash: string,
): Promise<ResetClaim | undefined> {
  const { rows } = await client.query<{
    user_id: string;
    tenant_id: string;
    role: string;
    totp_secret: string | null;
    mfa_enabled: boolean;
  }>("SELECT * FROM claim_password_reset($1)", [tokenHash]);

  const row = rows[0];
  return row
    ? {
        userId: row.user_id,
        tenantId: row.tenant_id,
        role: row.role,
        totpSecret: row.totp_secret,
        mfaEnabled: row.mfa_enabled,
      }
    : undefined;
}

export async function applyPasswordReset(
  client: PoolClient,
  userId: string,
  passwordHash: string,
): Promise<void> {
  await client.query("SELECT apply_password_reset($1, $2)", [userId, passwordHash]);
}

/** Every session, because a reset is what someone does when they suspect one is not theirs. */
export async function revokeSessionsForUser(
  client: PoolClient,
  userId: string,
): Promise<number> {
  const { rows } = await client.query<{ revoke_sessions_for_user: number }>(
    "SELECT revoke_sessions_for_user($1)",
    [userId],
  );
  return Number(rows[0]?.revoke_sessions_for_user ?? 0);
}

/**
 * Holds a new TOTP secret aside until a code proves it works.
 *
 * The secret in use is untouched, so a scan that did not take leaves the user
 * signing in exactly as before.
 */
export async function setPendingTotp(
  tx: TenantClient,
  userId: string,
  secret: string,
): Promise<void> {
  await tx.query(
    "UPDATE users SET pending_totp_secret = $2, pending_totp_at = now() WHERE id = $1",
    [userId, secret],
  );
}

export async function getPendingTotp(
  tx: TenantClient,
  userId: string,
): Promise<{ secret: string; at: Date } | undefined> {
  const { rows } = await tx.query<{ pending_totp_secret: string | null; pending_totp_at: Date | null }>(
    "SELECT pending_totp_secret, pending_totp_at FROM users WHERE id = $1",
    [userId],
  );
  const row = rows[0];
  if (!row?.pending_totp_secret || !row.pending_totp_at) return undefined;
  return { secret: row.pending_totp_secret, at: row.pending_totp_at };
}

/**
 * Promotes the pending secret to the one in use.
 *
 * One statement, and it clears the pending columns in the same breath: a
 * promotion that left the pending secret behind would leave a second working
 * factor nobody knows about.
 */
export async function activatePendingTotp(tx: TenantClient, userId: string): Promise<boolean> {
  const { rowCount } = await tx.query(
    `UPDATE users
        SET totp_secret = pending_totp_secret,
            mfa_enabled = true,
            pending_totp_secret = NULL,
            pending_totp_at = NULL
      WHERE id = $1 AND pending_totp_secret IS NOT NULL`,
    [userId],
  );
  return (rowCount ?? 0) > 0;
}

export async function discardPendingTotp(tx: TenantClient, userId: string): Promise<void> {
  await tx.query(
    "UPDATE users SET pending_totp_secret = NULL, pending_totp_at = NULL WHERE id = $1",
    [userId],
  );
}

/**
 * Replaces a user's recovery codes.
 *
 * Wholesale, because the old set belonged to the authenticator being replaced.
 * Leaving spent or superseded codes in place would keep a way in that the user
 * believes they have revoked.
 */
export async function replaceRecoveryCodes(
  tx: TenantClient,
  userId: string,
  hashes: string[],
): Promise<number> {
  await tx.query("DELETE FROM recovery_codes WHERE user_id = $1", [userId]);
  for (const hash of hashes) {
    await tx.query(
      "INSERT INTO recovery_codes (tenant_id, user_id, code_hash) VALUES (current_tenant_id(), $1, $2)",
      [userId, hash],
    );
  }
  return hashes.length;
}

export async function countUnusedRecoveryCodes(
  tx: TenantClient,
  userId: string,
): Promise<number> {
  const { rows } = await tx.query<{ n: string }>(
    "SELECT count(*) AS n FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL",
    [userId],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Spends one recovery code, if it is there and unused.
 *
 * Atomic, for the same reason `consumeTotp` is: the `used_at IS NULL` sits in
 * the UPDATE rather than in a preceding SELECT, so two simultaneous uses of one
 * code cannot both succeed.
 *
 * Runs through a SECURITY DEFINER function because sign-in happens before a
 * tenant scope exists - the same arrangement `findUserForLogin` and
 * `consumeTotp` use. The application connection carries no `app.tenant_id` at
 * this point, so the row level policy on recovery_codes would match nothing and
 * every code would look already spent.
 */
export async function claimRecoveryCode(
  client: PoolClient,
  userId: string,
  codeHash: string,
): Promise<boolean> {
  const { rows } = await client.query<{ claim_recovery_code: boolean }>(
    "SELECT claim_recovery_code($1, $2)",
    [userId, codeHash],
  );
  return rows[0]?.claim_recovery_code === true;
}

export interface ApiKeyRow {
  id: string;
  name: string;
  environment: string;
  prefix: string;
  scopes: string[];
  created_at: Date;
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

/** Never returns `token_hash`. There is no path that reveals a key twice. */
export async function listApiKeys(tx: TenantClient): Promise<ApiKeyRow[]> {
  const { rows } = await tx.query<ApiKeyRow>(
    `SELECT id, name, environment, prefix, scopes, created_at,
            expires_at, last_used_at, revoked_at
       FROM api_keys
      ORDER BY revoked_at NULLS FIRST, created_at DESC`,
  );
  return rows;
}

/**
 * Revokes a key.
 *
 * Marked rather than deleted: a key that was used needs to stay explicable
 * afterwards, and `last_used_at` on a row that no longer exists explains
 * nothing. Already-revoked keys are left alone so the first revocation time
 * stands.
 */
export async function revokeApiKey(tx: TenantClient, id: string): Promise<boolean> {
  const { rowCount } = await tx.query(
    "UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL",
    [id],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * The email and password hash for a user already identified by their session.
 *
 * The hash re-authenticates before a change to the credentials themselves; the
 * email labels the entry in the authenticator app, where a user id would leave
 * someone looking at a UUID trying to work out which account it belongs to.
 *
 * Scoped to the tenant, unlike `findUserForLogin`: by this point a session has
 * established which tenant is asking, so there is no reason to reach outside
 * it.
 */
export async function getAccountUser(
  tx: TenantClient,
  userId: string,
): Promise<{ email: string; passwordHash: string | null } | undefined> {
  const { rows } = await tx.query<{ email: string; password_hash: string | null }>(
    "SELECT email, password_hash FROM users WHERE id = $1",
    [userId],
  );
  const row = rows[0];
  return row ? { email: row.email, passwordHash: row.password_hash } : undefined;
}
