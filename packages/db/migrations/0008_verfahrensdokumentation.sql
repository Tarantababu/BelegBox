-- The Verfahrensdokumentation, kept as versions rather than as a current state.
--
-- GoBD Rz. 154 requires a change history and the retention of superseded
-- versions: what matters in a Betriebsprüfung is the fassung that was in force
-- during the period under review, not the one in force today. A table that held
-- only the latest text would destroy exactly the evidence the requirement is
-- about, so this is append-only like audit_log and archive_chain.
--
-- Each fassung carries the hash of its content and the hash of the one before
-- it. Same construction as archive_chain, same reason: a rewritten fassung 3 no
-- longer matches what fassung 4 says came before it.

CREATE TABLE verfahrensdokumentationen (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid    NOT NULL REFERENCES tenants(id),
  version       integer NOT NULL CHECK (version >= 1),

  content_hash  text    NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  prev_hash     text             CHECK (prev_hash    ~ '^[0-9a-f]{64}$'),

  -- The facts the fassung was generated from. Keeping them makes the document
  -- re-derivable: the same input renders the same bytes and the same hash, so a
  -- stored fassung can be checked rather than taken on trust.
  facts         jsonb   NOT NULL,
  -- The rendered document as it was handed over.
  html          text    NOT NULL,

  open_items    integer NOT NULL CHECK (open_items >= 0),
  -- False while any open item is unanswered. A draft presented as finished is
  -- the failure this column exists to make visible.
  complete      boolean NOT NULL,

  generated_by  uuid    REFERENCES users(id),
  generated_at  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, version),
  -- Fassung 1 has no predecessor; every later one must name it.
  CONSTRAINT chain_start CHECK ((version = 1) = (prev_hash IS NULL))
);

CREATE INDEX verfahrensdokumentationen_tenant_version
  ON verfahrensdokumentationen (tenant_id, version DESC);

ALTER TABLE verfahrensdokumentationen ENABLE ROW LEVEL SECURITY;
ALTER TABLE verfahrensdokumentationen FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON verfahrensdokumentationen
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT ON verfahrensdokumentationen TO belegbox_app;

CREATE TRIGGER verfahrensdokumentationen_append_only
  BEFORE UPDATE OR DELETE ON verfahrensdokumentationen
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

-- Not tenant data: the schema version is a property of the installation, and it
-- is the same row for every tenant. The Verfahrensdokumentation states it as
-- technical system documentation, so the application role needs to read it.
GRANT SELECT ON schema_migrations TO belegbox_app;
