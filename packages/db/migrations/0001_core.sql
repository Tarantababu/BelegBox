-- Core schema: tenants, users, inboxes, documents, findings, and the two
-- append-only tables. Forward-only; never edit a migration that has shipped.

CREATE TABLE tenants (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text        NOT NULL,
  slug             text        NOT NULL UNIQUE,
  vat_id           text,
  tax_number       text,
  country          text        NOT NULL DEFAULT 'DE',
  industry         text,
  ruleset_id       uuid,
  locale           text        NOT NULL DEFAULT 'de',
  retention_policy jsonb       NOT NULL DEFAULT '{"invoices_years":10,"vouchers_years":8}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  email       text NOT NULL,
  role        text NOT NULL CHECK (role IN ('owner','accountant','approver','viewer','api')),
  locale      text NOT NULL DEFAULT 'de',
  mfa_enabled boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inboxes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  address    text NOT NULL UNIQUE,
  slug       text NOT NULL,
  suffix     text NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  inbox_id       uuid REFERENCES inboxes(id),
  direction      text NOT NULL DEFAULT 'incoming' CHECK (direction IN ('incoming','outgoing')),

  format         text,
  profile_urn    text,
  source_channel text NOT NULL CHECK (source_channel IN ('email','upload','api','peppol')),

  raw_object_key text NOT NULL,
  raw_sha256     text NOT NULL CHECK (raw_sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes     bigint NOT NULL,
  filename       text,
  content_type   text,

  verdict_form    text NOT NULL DEFAULT 'n_a' CHECK (verdict_form    IN ('pass','fail','n_a','unknown')),
  verdict_content text NOT NULL DEFAULT 'n_a' CHECK (verdict_content IN ('pass','fail','n_a','unknown')),
  status          text NOT NULL CHECK (status IN ('clean','form_error','content_error','not_einvoice','pending')),

  parsed jsonb,

  -- R-3: a corrected invoice (UNTDID 1001 code 384) or credit note (381) must
  -- point at what it corrects, or it arrives as an unrelated row.
  doc_type_code        text,
  corrects_document_id uuid REFERENCES documents(id),

  -- Email channel forensics (§ 10.3). The inbound mailbox is the real attack
  -- surface; a forged invoice with a swapped IBAN is the loss event.
  sender_auth jsonb,
  message_id  text,

  received_at    timestamptz NOT NULL DEFAULT now(),
  issued_at      date,
  due_at         date,
  archived_at    timestamptz,
  archive_hash   text,
  retention_until date
);

-- Byte-identical resends collapse. Scoped per tenant: two tenants legitimately
-- receive the same invoice from a shared supplier.
CREATE UNIQUE INDEX documents_tenant_sha_uniq ON documents (tenant_id, raw_sha256);
CREATE INDEX documents_tenant_received  ON documents (tenant_id, received_at DESC);
CREATE INDEX documents_tenant_status    ON documents (tenant_id, status);
CREATE INDEX documents_tenant_archived  ON documents (tenant_id, archived_at);

CREATE TABLE findings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  document_id uuid NOT NULL REFERENCES documents(id),
  layer       text NOT NULL CHECK (layer IN ('l1_schema','l2_schematron','l3_domain','l4_tenant')),
  code        text NOT NULL,
  severity    text NOT NULL CHECK (severity IN ('form_error','content_error','warning','info')),
  bt_ref      text,
  legal_basis text,
  message_raw text NOT NULL,
  explain_key text,
  params      jsonb,

  -- R-2. A verdict must be re-derivable in 2033, so the versions that produced
  -- it are part of the record rather than a deployment detail.
  validator_config_version text NOT NULL,
  engine_version           text NOT NULL,
  ruleset_version          integer,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX findings_document ON findings (document_id);

-- L4 cannot fail the form verdict. The TypeScript type says so; so does this.
ALTER TABLE findings ADD CONSTRAINT findings_tenant_rules_never_form_error
  CHECK (NOT (layer = 'l4_tenant' AND severity = 'form_error'));

CREATE TABLE rulesets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid REFERENCES tenants(id),
  template   text NOT NULL,
  version    integer NOT NULL,
  yaml       text NOT NULL,
  active     boolean NOT NULL DEFAULT false,

  -- R-1. Rules are chosen by the document's issue date, not by now(), or the
  -- archive re-judges itself every time the law changes.
  effective_from date NOT NULL,
  effective_to   date,

  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

-- R-4: gapless outgoing numbering, GoBD Vollständigkeit.
CREATE TABLE number_ranges (
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  key        text NOT NULL,
  next_value bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, key)
);

-- R-5: evidence that an outgoing invoice was actually sent.
CREATE TABLE dispatches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  document_id     uuid NOT NULL REFERENCES documents(id),
  channel         text NOT NULL,
  recipient       text NOT NULL,
  smtp_message_id text,
  sent_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  actor       text NOT NULL,
  action      text NOT NULL,
  object_type text NOT NULL,
  object_id   text,
  before      jsonb,
  after       jsonb,
  ip          inet,
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_tenant_at ON audit_log (tenant_id, at DESC);

CREATE TABLE archive_chain (
  day         date NOT NULL,
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  merkle_root text NOT NULL CHECK (merkle_root ~ '^[0-9a-f]{64}$'),
  prev_root   text          CHECK (prev_root   ~ '^[0-9a-f]{64}$'),
  tree_size   integer NOT NULL CHECK (tree_size >= 0),
  sealed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, day)
);
