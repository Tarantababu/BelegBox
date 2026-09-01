-- One-time use for TOTP codes.
--
-- Without this, a code observed inside its 30-second window can be replayed:
-- a phishing page that relays the code, a shoulder-surf, a proxy log. The
-- second factor then only defends against a guessed password, which is not
-- what it is for.
--
-- The claim is atomic rather than check-then-write, for the same reason the
-- inbound message claim is: two concurrent uses of one code must not both win.

CREATE TABLE totp_used (
  user_id uuid NOT NULL REFERENCES users(id),
  counter bigint NOT NULL,
  used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, counter)
);

/*
 * Claims one time step for one user. True when this call won it.
 *
 * SECURITY DEFINER and unscoped: authentication happens before a tenant scope
 * exists. It also prunes the user's older entries, so the table stays the size
 * of one login rather than growing forever - a code from more than a few
 * minutes ago is outside the acceptance window anyway.
 */
CREATE OR REPLACE FUNCTION consume_totp(p_user_id uuid, p_counter bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  claimed boolean;
BEGIN
  INSERT INTO totp_used (user_id, counter) VALUES (p_user_id, p_counter)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS claimed = ROW_COUNT;

  DELETE FROM totp_used
   WHERE user_id = p_user_id AND used_at < now() - interval '10 minutes';

  RETURN claimed;
END;
$$;

REVOKE ALL ON FUNCTION consume_totp(uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION consume_totp(uuid, bigint) TO belegbox_app;
GRANT SELECT, INSERT, DELETE ON totp_used TO belegbox_app;
