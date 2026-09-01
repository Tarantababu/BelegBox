-- Denormalised columns for the inbox listing.
--
-- The parsed BT fields live in `parsed` as JSONB, but the inbox reads five of
-- them on every row and sorts on a sixth. Digging into JSONB for that turns a
-- single index scan into a per-row extraction, and this is the one screen a
-- user opens every day for ten years.

ALTER TABLE documents ADD COLUMN supplier_name   text;
ALTER TABLE documents ADD COLUMN supplier_vat_id text;
ALTER TABLE documents ADD COLUMN invoice_number  text;
ALTER TABLE documents ADD COLUMN total_gross     numeric(14,2);
ALTER TABLE documents ADD COLUMN total_net       numeric(14,2);
ALTER TABLE documents ADD COLUMN total_vat       numeric(14,2);

-- D-007 asks "has this supplier sent this number before?" on every ingest.
CREATE INDEX documents_supplier_invoice
  ON documents (tenant_id, supplier_vat_id, invoice_number);

-- Full-text search over supplier and invoice number (M-05).
CREATE INDEX documents_supplier_trgm
  ON documents USING gin (supplier_name gin_trgm_ops);
