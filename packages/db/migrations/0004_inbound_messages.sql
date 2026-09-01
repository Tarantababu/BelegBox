-- Idempotency for inbound mail.
--
-- Every provider redelivers on timeout, so the same message arrives more than
-- once and must produce one set of documents. The obvious shape - check, then
-- process, then record - loses to two concurrent redeliveries: both checks miss
-- and both write. The claim below is atomic instead.

CREATE TABLE inbound_messages (
  id                  bigserial PRIMARY KEY,
  provider            text NOT NULL,
  provider_message_id text NOT NULL,
  -- Null when the recipient matched no inbox. Misdirected mail and probes are
  -- worth keeping: they are the visible edge of the attack surface, and the RLS
  -- policy below makes them invisible to every tenant rather than guessing an
  -- owner.
  tenant_id           uuid REFERENCES tenants(id),
  recipient           text,
  message_id          text,
  document_count      integer NOT NULL DEFAULT 0,
  warnings            text[] NOT NULL DEFAULT '{}',
  received_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX inbound_messages_provider_id
  ON inbound_messages (provider, provider_message_id);

ALTER TABLE inbound_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_messages FORCE ROW LEVEL SECURITY;
-- A NULL tenant_id compares to NULL, which is not true, so an unroutable
-- message is hidden from everyone. That is the correct answer: it belongs to
-- no tenant.
CREATE POLICY tenant_isolation ON inbound_messages
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON inbound_messages TO belegbox_app;
GRANT USAGE, SELECT ON SEQUENCE inbound_messages_id_seq TO belegbox_app;

/*
 * Claims a message for processing, exactly once.
 *
 * SECURITY DEFINER because deduplication is a system concern rather than tenant
 * data: the worker must be able to see that another tenant already claimed a
 * message id without being able to read that tenant's row. It runs inside the
 * caller's transaction, so a rollback releases the claim - processing failures
 * do not permanently swallow a redelivery.
 */
CREATE OR REPLACE FUNCTION claim_inbound_message(
  p_provider   text,
  p_message_id text,
  p_tenant     uuid,
  p_recipient  text,
  p_rfc_id     text
) RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO inbound_messages (provider, provider_message_id, tenant_id, recipient, message_id)
  VALUES (p_provider, p_message_id, p_tenant, p_recipient, p_rfc_id)
  ON CONFLICT (provider, provider_message_id) DO NOTHING
  RETURNING id;
$$;

REVOKE ALL ON FUNCTION claim_inbound_message(text, text, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_inbound_message(text, text, uuid, text, text) TO belegbox_app;

/* Records the outcome once processing is done. Same reasoning. */
CREATE OR REPLACE FUNCTION finish_inbound_message(
  p_id       bigint,
  p_count    integer,
  p_warnings text[]
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE inbound_messages
     SET document_count = p_count, warnings = COALESCE(p_warnings, '{}')
   WHERE id = p_id;
$$;

REVOKE ALL ON FUNCTION finish_inbound_message(bigint, integer, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finish_inbound_message(bigint, integer, text[]) TO belegbox_app;

/*
 * Resolves an inbox address to its tenant.
 *
 * This runs before any tenant scope exists - it is the step that establishes
 * one - so it cannot go through RLS. It matches the full address exactly and
 * returns nothing else, so knowing an address reveals only the tenant that
 * address already belongs to.
 */
CREATE OR REPLACE FUNCTION resolve_inbox(p_address text)
RETURNS TABLE (inbox_id uuid, tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, tenant_id FROM inboxes WHERE lower(address) = lower(p_address) AND active;
$$;

REVOKE ALL ON FUNCTION resolve_inbox(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_inbox(text) TO belegbox_app;
