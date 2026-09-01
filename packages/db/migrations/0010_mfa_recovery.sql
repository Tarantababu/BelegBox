-- Re-enrolling a second factor, and surviving a lost phone.
--
-- Two problems, one migration.
--
-- Rotating a TOTP secret has to be a two-step act. Replacing the secret the
-- moment a new one is issued locks out anyone whose authenticator did not
-- accept it - a mistyped scan, a phone with a wrong clock - and the account
-- they are locked out of is the one holding ten years of tax records. So the
-- new secret is held aside until a code proves it works, and only then does it
-- replace the one in use.
--
-- The pending secret is kept server-side rather than handed to the browser and
-- taken back on confirm. Round-tripping it would let a caller confirm a secret
-- of their own choosing, which is exactly what someone with a stolen session
-- would want.

ALTER TABLE users ADD COLUMN pending_totp_secret text;
ALTER TABLE users ADD COLUMN pending_totp_at     timestamptz;

-- Recovery codes: the answer to "my phone is gone".
--
-- Without them a lost device means a lost account, and the only remedy is an
-- operator reaching into the database - which is the access this system is
-- built to not need. Ten single-use codes, shown once.
--
-- Hashed with SHA-256 rather than the password KDF. These are 160 bits of
-- machine-generated randomness, not a memorable secret, so there is nothing for
-- a slow hash to defend against - the same reasoning that governs API tokens.
-- A slow hash here would also mean ten scrypt runs on every sign-in attempt
-- that offers a code.
CREATE TABLE recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  user_id    uuid NOT NULL REFERENCES users(id),
  code_hash  text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at    timestamptz,

  -- Scoped to the user, not global: two users may not share a code, and the
  -- uniqueness must not leak that a code exists on some other account.
  UNIQUE (user_id, code_hash)
);

CREATE INDEX recovery_codes_user_unused
  ON recovery_codes (user_id) WHERE used_at IS NULL;

ALTER TABLE recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE recovery_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON recovery_codes
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- DELETE is granted, unlike the append-only tables: a code set is replaced
-- wholesale when the user re-enrols, and keeping spent codes from a superseded
-- authenticator serves nothing. This is credential material, not a record.
GRANT SELECT, INSERT, UPDATE, DELETE ON recovery_codes TO belegbox_app;

-- Sign-in has to find a candidate before a tenant scope exists, the same way
-- it already does for users.
CREATE INDEX recovery_codes_lookup ON recovery_codes (user_id, code_hash);

/*
 * Spends one recovery code. True when this call won it.
 *
 * SECURITY DEFINER and unscoped, for the same reason `consume_totp` and
 * `find_user_for_login` are: sign-in happens before a tenant scope exists, so
 * the application's own connection has no `app.tenant_id` and the row level
 * policy on recovery_codes would match nothing. Written as a function rather
 * than by relaxing the policy, so the only unscoped access is this one
 * statement, keyed on a user id the password has already identified.
 *
 * The `used_at IS NULL` sits in the UPDATE rather than in a preceding SELECT:
 * two simultaneous uses of one code must not both succeed.
 */
CREATE OR REPLACE FUNCTION claim_recovery_code(p_user_id uuid, p_code_hash text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  claimed boolean;
BEGIN
  UPDATE recovery_codes
     SET used_at = now()
   WHERE user_id = p_user_id
     AND code_hash = p_code_hash
     AND used_at IS NULL;
  GET DIAGNOSTICS claimed = ROW_COUNT;
  RETURN claimed;
END;
$$;

REVOKE ALL ON FUNCTION claim_recovery_code(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_recovery_code(uuid, text) TO belegbox_app;
