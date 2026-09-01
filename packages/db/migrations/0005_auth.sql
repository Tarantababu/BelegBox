-- Authentication: credentials, sessions, API keys.

-- One account per address. Case-insensitive, because people type their own
-- email inconsistently and two accounts for one person is a support problem
-- and a security one.
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));

ALTER TABLE users ADD COLUMN password_hash  text;
ALTER TABLE users ADD COLUMN totp_secret    text;
ALTER TABLE users ADD COLUMN failed_logins  integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until   timestamptz;
ALTER TABLE users ADD COLUMN last_login_at  timestamptz;

/*
 * Sessions.
 *
 * Opaque random tokens rather than JWTs. A JWT cannot be revoked before it
 * expires without the server-side list that a session table already is, and it
 * adds signing keys and algorithm confusion to the threat model in exchange for
 * a lookup this system performs anyway.
 *
 * Only the hash is stored. A database leak then yields no usable session, the
 * same reason password hashes exist.
 */
CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  token_hash   text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ip           inet,
  user_agent   text,
  revoked_at   timestamptz
);

CREATE INDEX sessions_user ON sessions (user_id) WHERE revoked_at IS NULL;

/*
 * API keys for BB-API (PRD § 8.2).
 *
 * The key type decides the environment, so there is no separate sandbox URL.
 * Scopes and an expiry are columns rather than a later migration because a key
 * that never expires and can do everything is what a leaked key wants to be.
 */
CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  name         text NOT NULL,
  environment  text NOT NULL CHECK (environment IN ('live','test')),
  -- Shown in the UI so a key can be identified without revealing it.
  prefix       text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  scopes       text[] NOT NULL DEFAULT '{}',
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  last_used_at timestamptz,
  revoked_at   timestamptz
);

CREATE INDEX api_keys_tenant ON api_keys (tenant_id) WHERE revoked_at IS NULL;

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sessions
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON api_keys
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON sessions, api_keys TO belegbox_app;

/*
 * Authenticates a session token.
 *
 * SECURITY DEFINER because this is the step that establishes the tenant scope -
 * there is no scope to look it up under. It takes the hash, never the token,
 * and returns only what the caller needs to become that tenant.
 *
 * Expiry and revocation are checked here rather than by the caller, so a
 * forgotten condition in application code cannot resurrect a dead session.
 */
CREATE OR REPLACE FUNCTION authenticate_session(p_token_hash text)
RETURNS TABLE (session_id uuid, tenant_id uuid, user_id uuid, role text, locale text, mfa_enabled boolean)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.id, s.tenant_id, s.user_id, u.role, u.locale, u.mfa_enabled
    FROM sessions s
    JOIN users u ON u.id = s.user_id
   WHERE s.token_hash = p_token_hash
     AND s.revoked_at IS NULL
     AND s.expires_at > now();
$$;

REVOKE ALL ON FUNCTION authenticate_session(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authenticate_session(text) TO belegbox_app;

CREATE OR REPLACE FUNCTION touch_session(p_session_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE sessions SET last_seen_at = now() WHERE id = p_session_id;
$$;

REVOKE ALL ON FUNCTION touch_session(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION touch_session(uuid) TO belegbox_app;

/* Same reasoning for API keys. */
CREATE OR REPLACE FUNCTION authenticate_api_key(p_token_hash text)
RETURNS TABLE (key_id uuid, tenant_id uuid, scopes text[], environment text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT k.id, k.tenant_id, k.scopes, k.environment
    FROM api_keys k
   WHERE k.token_hash = p_token_hash
     AND k.revoked_at IS NULL
     AND (k.expires_at IS NULL OR k.expires_at > now());
$$;

REVOKE ALL ON FUNCTION authenticate_api_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authenticate_api_key(text) TO belegbox_app;

/*
 * Looks a user up for sign-in.
 *
 * Also unscoped by necessity. Returns the hash so the caller can verify it, and
 * the lockout state so the caller can refuse without a second round trip.
 */
CREATE OR REPLACE FUNCTION find_user_for_login(p_email text)
RETURNS TABLE (user_id uuid, tenant_id uuid, password_hash text, totp_secret text,
               role text, locale text, mfa_enabled boolean, locked_until timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, tenant_id, password_hash, totp_secret, role, locale, mfa_enabled, locked_until
    FROM users WHERE lower(email) = lower(p_email);
$$;

REVOKE ALL ON FUNCTION find_user_for_login(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION find_user_for_login(text) TO belegbox_app;

/* Records the outcome of an attempt. Lockout is data, not application memory. */
CREATE OR REPLACE FUNCTION record_login_attempt(p_user_id uuid, p_success boolean, p_max_failures integer, p_lock_minutes integer)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE users
     SET failed_logins = CASE WHEN p_success THEN 0 ELSE failed_logins + 1 END,
         last_login_at = CASE WHEN p_success THEN now() ELSE last_login_at END,
         locked_until  = CASE
           WHEN p_success THEN NULL
           WHEN failed_logins + 1 >= p_max_failures THEN now() + make_interval(mins => p_lock_minutes)
           ELSE locked_until END
   WHERE id = p_user_id;
$$;

REVOKE ALL ON FUNCTION record_login_attempt(uuid, boolean, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_login_attempt(uuid, boolean, integer, integer) TO belegbox_app;
