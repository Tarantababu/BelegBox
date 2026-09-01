-- Self-service signup, which had never actually run as the application role.
--
-- Creating a tenant is the one write that cannot happen inside a tenant scope,
-- because it is the write that brings the scope into existence. 0002 said as
-- much and concluded "the owner role provisions" - but the signup endpoint is
-- public and runs as `belegbox_app`, so in production it answered
-- `permission denied for table tenants` on the very first request. It never
-- showed up in development because the seed connects as the superuser and no
-- test drove the endpoint against the application role.
--
-- The pattern for "must happen before a tenant scope exists" is already here:
-- `find_user_for_login`, `consume_totp`, `revoke_sessions_for_user` and
-- `claim_recovery_code` are all SECURITY DEFINER for the same reason. This is
-- the fifth, and the narrowest thing that works - one function, one insert
-- each into two tables, nothing that can reach an existing tenant's rows.
--
-- Deliberately NOT done instead: granting INSERT on `tenants` to the
-- application role. That would let any code path holding an ordinary
-- connection mint a tenant, and the grant would sit there long after anyone
-- remembered why.

CREATE OR REPLACE FUNCTION provision_tenant(
  p_name          text,
  p_slug          text,
  p_inbox_address text,
  p_inbox_suffix  text,
  p_vat_id        text DEFAULT NULL,
  p_tax_number    text DEFAULT NULL,
  p_industry      text DEFAULT NULL,
  p_locale        text DEFAULT 'de'
)
RETURNS TABLE (
  tenant_id  uuid,
  inbox_id   uuid,
  name       text,
  slug       text,
  vat_id     text,
  tax_number text,
  country    text,
  industry   text,
  locale     text,
  retention_policy jsonb,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_tenant tenants%ROWTYPE;
  new_inbox  uuid;
BEGIN
  INSERT INTO tenants (name, slug, vat_id, tax_number, industry, locale)
  VALUES (p_name, p_slug, p_vat_id, p_tax_number, p_industry, coalesce(p_locale, 'de'))
  RETURNING * INTO new_tenant;

  -- One statement with the insert above: a tenant without an inbox has no
  -- address to give suppliers, and setup would report success on a half-built
  -- account. A function body is a single transaction, so this cannot end up
  -- half-applied the way the previous BEGIN/COMMIT pair could.
  INSERT INTO inboxes (tenant_id, address, slug, suffix)
  VALUES (new_tenant.id, p_inbox_address, p_slug, p_inbox_suffix)
  RETURNING id INTO new_inbox;

  RETURN QUERY SELECT
    new_tenant.id, new_inbox, new_tenant.name, new_tenant.slug,
    new_tenant.vat_id, new_tenant.tax_number, new_tenant.country,
    new_tenant.industry, new_tenant.locale, new_tenant.retention_policy,
    new_tenant.created_at;
END;
$$;

REVOKE ALL ON FUNCTION provision_tenant(text, text, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION provision_tenant(text, text, text, text, text, text, text, text)
  TO belegbox_app;
