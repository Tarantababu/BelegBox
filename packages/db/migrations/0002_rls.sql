-- Tenant isolation and append-only enforcement.
--
-- Two things are being defended here:
--
--   1. A missing WHERE tenant_id clause must not leak another tenant's
--      invoices. Application-level filtering is one forgotten join away from a
--      breach, so the database refuses rather than trusting the query.
--   2. audit_log and archive_chain must be append-only even to the application.
--      That is a grant, not a convention - GoBD Unveränderbarkeit is worth
--      nothing if the process that writes the log can also rewrite it.

-- Reads current_setting('app.tenant_id'). The `true` argument makes a missing
-- setting return NULL instead of raising, so an unscoped query returns zero
-- rows rather than an error that might get caught and ignored.
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','inboxes','documents','findings','rulesets',
    'number_ranges','dispatches','audit_log','archive_chain'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- FORCE binds the table OWNER to the policy as well. It does not bind a
    -- superuser or a role with BYPASSRLS - nothing in the database can. So
    -- FORCE closes the owner hole, and the operational rule closes the rest:
    -- the application connects as belegbox_app, which owns nothing, is not a
    -- superuser, and must never be granted BYPASSRLS.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) '
      'WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
END
$$;

-- tenants is addressed by its own id rather than a tenant_id column, and it is
-- deliberately NOT forced: provisioning a new tenant has to insert the row that
-- defines the scope, which no tenant-scoped policy can satisfy. The owner role
-- provisions; the application role is a non-owner and stays subject to the
-- policy.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants
  USING (id = current_tenant_id())
  WITH CHECK (id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON
  users, inboxes, documents, findings, rulesets, number_ranges, dispatches
  TO belegbox_app;
GRANT SELECT ON tenants TO belegbox_app;

-- Append-only. No UPDATE, no DELETE, for any application role, ever.
GRANT SELECT, INSERT ON audit_log, archive_chain TO belegbox_app;
GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO belegbox_app;

-- Belt and braces: a future GRANT by mistake still cannot rewrite history.
CREATE OR REPLACE FUNCTION refuse_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (GoBD Unveränderbarkeit); % is not permitted',
    TG_TABLE_NAME, TG_OP;
END
$$;

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

CREATE TRIGGER archive_chain_append_only
  BEFORE UPDATE OR DELETE ON archive_chain
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

-- An archived document is sealed. Its raw bytes and the digest that proves them
-- cannot move afterwards, or every inclusion proof over that day becomes a lie.
CREATE OR REPLACE FUNCTION refuse_archived_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.archived_at IS NOT NULL AND (
       NEW.raw_sha256     IS DISTINCT FROM OLD.raw_sha256 OR
       NEW.raw_object_key IS DISTINCT FROM OLD.raw_object_key OR
       NEW.size_bytes     IS DISTINCT FROM OLD.size_bytes OR
       NEW.archived_at    IS DISTINCT FROM OLD.archived_at OR
       NEW.tenant_id      IS DISTINCT FROM OLD.tenant_id
     ) THEN
    RAISE EXCEPTION 'document % is archived; its stored bytes and digest are immutable', OLD.id;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER documents_archived_immutable
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION refuse_archived_change();

CREATE TRIGGER documents_no_delete
  BEFORE DELETE ON documents
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
