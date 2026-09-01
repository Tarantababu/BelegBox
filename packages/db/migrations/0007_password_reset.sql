-- Password reset.
--
-- The dangerous part of any account system: it is a supported path from
-- "controls an inbox" to "controls the account", so every property the login
-- flow establishes has to survive it.

CREATE TABLE password_resets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  requested_ip inet
);

CREATE INDEX password_resets_user ON password_resets (user_id) WHERE used_at IS NULL;

/*
 * Issues a reset token.
 *
 * SECURITY DEFINER and unscoped: a person asking to reset a password has no
 * session, so there is no tenant scope to run under.
 *
 * Outstanding tokens for the same user are invalidated first. Two live reset
 * links mean the older one still works after the newer was used, which is
 * exactly the window someone forwarding a suspicious email would leave open.
 */
CREATE OR REPLACE FUNCTION issue_password_reset(
  p_user_id uuid,
  p_token_hash text,
  p_expires_at timestamptz,
  p_ip inet
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_id uuid;
BEGIN
  UPDATE password_resets SET used_at = now()
   WHERE user_id = p_user_id AND used_at IS NULL;

  INSERT INTO password_resets (user_id, token_hash, expires_at, requested_ip)
  VALUES (p_user_id, p_token_hash, p_expires_at, p_ip)
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$$;

REVOKE ALL ON FUNCTION issue_password_reset(uuid, text, timestamptz, inet) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION issue_password_reset(uuid, text, timestamptz, inet) TO belegbox_app;

/*
 * Claims a reset token, exactly once.
 *
 * Returns the user it belongs to, and marks it used in the same statement. Two
 * concurrent uses of one link cannot both win, and a token that is expired or
 * already spent returns nothing rather than a distinguishable error.
 *
 * The second factor travels back with it: a reset must not become a way around
 * MFA, so the caller needs to know whether one is required before it changes
 * anything.
 */
CREATE OR REPLACE FUNCTION claim_password_reset(p_token_hash text)
RETURNS TABLE (user_id uuid, tenant_id uuid, role text, totp_secret text, mfa_enabled boolean)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH claimed AS (
    UPDATE password_resets
       SET used_at = now()
     WHERE token_hash = p_token_hash
       AND used_at IS NULL
       AND expires_at > now()
    RETURNING password_resets.user_id
  )
  SELECT u.id, u.tenant_id, u.role, u.totp_secret, u.mfa_enabled
    FROM claimed JOIN users u ON u.id = claimed.user_id;
$$;

REVOKE ALL ON FUNCTION claim_password_reset(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_password_reset(text) TO belegbox_app;

/*
 * Applies a new password.
 *
 * Clears the lockout, because the person who proved control of the inbox and
 * the second factor is the owner, not whoever was guessing. Sessions are
 * revoked by the caller: a reset is what someone does when they think another
 * person has their account, and leaving that person signed in would defeat it.
 */
CREATE OR REPLACE FUNCTION apply_password_reset(p_user_id uuid, p_password_hash text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE users
     SET password_hash = p_password_hash,
         failed_logins = 0,
         locked_until = NULL
   WHERE id = p_user_id;
$$;

REVOKE ALL ON FUNCTION apply_password_reset(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apply_password_reset(uuid, text) TO belegbox_app;

/* Revoking every session belongs to the reset, not to the caller's discipline. */
CREATE OR REPLACE FUNCTION revoke_sessions_for_user(p_user_id uuid) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  affected integer;
BEGIN
  UPDATE sessions SET revoked_at = now()
   WHERE user_id = p_user_id AND revoked_at IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

REVOKE ALL ON FUNCTION revoke_sessions_for_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revoke_sessions_for_user(uuid) TO belegbox_app;

ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_resets FORCE ROW LEVEL SECURITY;
-- No policy: nothing reaches this table except the functions above, which run
-- as the owner. There is no tenant-scoped reason to read it.
GRANT SELECT, INSERT, UPDATE ON password_resets TO belegbox_app;

/*
 * Reads a reset token without spending it.
 *
 * Needed because the second factor is checked before the token is claimed. If
 * claiming came first, a user who mistyped six digits would lose their one
 * link - the same usability trap the login flow had, arrived at from the other
 * direction.
 */
CREATE OR REPLACE FUNCTION find_password_reset(p_token_hash text)
RETURNS TABLE (user_id uuid, tenant_id uuid, role text, totp_secret text, mfa_enabled boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT u.id, u.tenant_id, u.role, u.totp_secret, u.mfa_enabled
    FROM password_resets r JOIN users u ON u.id = r.user_id
   WHERE r.token_hash = p_token_hash
     AND r.used_at IS NULL
     AND r.expires_at > now();
$$;

REVOKE ALL ON FUNCTION find_password_reset(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION find_password_reset(text) TO belegbox_app;
