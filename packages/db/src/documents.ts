import type { TenantClient } from "./client.js";

export interface InsertDocumentInput {
  inboxId?: string | null;
  direction?: "incoming" | "outgoing";
  sourceChannel: "email" | "upload" | "api" | "peppol";
  rawObjectKey: string;
  rawSha256: string;
  sizeBytes: number;
  filename?: string | null;
  contentType?: string | null;
  format?: string | null;
  profileUrn?: string | null;
  status: "clean" | "form_error" | "content_error" | "not_einvoice" | "pending";
  verdictForm?: "pass" | "fail" | "n_a" | "unknown";
  verdictContent?: "pass" | "fail" | "n_a" | "unknown";
  docTypeCode?: string | null;
  correctsDocumentId?: string | null;
  senderAuth?: unknown;
  messageId?: string | null;
  issuedAt?: string | null;
  dueAt?: string | null;
  receivedAt?: string | null;
  /** Denormalised for the inbox listing - see migration 0003. */
  supplierName?: string | null;
  supplierVatId?: string | null;
  invoiceNumber?: string | null;
  totalGross?: number | null;
  totalNet?: number | null;
  totalVat?: number | null;
  /**
   * The normalised invoice. Everything downstream that needs a field the
   * summary columns do not carry - the payment account, the line items - reads
   * it from here rather than re-parsing the raw bytes.
   */
  parsed?: unknown;
}

export interface DocumentRow {
  id: string;
  tenant_id: string;
  raw_sha256: string;
  raw_object_key: string;
  size_bytes: string;
  status: string;
  verdict_form: string;
  verdict_content: string;
  format: string | null;
  profile_urn: string | null;
  supplier_name: string | null;
  supplier_vat_id: string | null;
  invoice_number: string | null;
  total_gross: string | null;
  total_net: string | null;
  total_vat: string | null;
  issued_at: string | null;
  due_at: string | null;
  archived_at: Date | null;
  archive_hash: string | null;
  received_at: Date;
  parsed: unknown;
}

/**
 * Inserts a document, or returns the existing one for a byte-identical resend.
 *
 * The uniqueness is on (tenant_id, raw_sha256), not on the digest alone: two
 * tenants buying from the same wholesaler legitimately receive the same file,
 * and neither should be able to observe that the other did.
 */
export async function insertDocument(
  tx: TenantClient,
  input: InsertDocumentInput,
): Promise<{ id: string; duplicate: boolean }> {
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO documents (
       tenant_id, inbox_id, direction, source_channel,
       raw_object_key, raw_sha256, size_bytes, filename, content_type,
       format, profile_urn, status, verdict_form, verdict_content,
       doc_type_code, corrects_document_id, sender_auth, message_id,
       issued_at, due_at, received_at,
       supplier_name, supplier_vat_id, invoice_number,
       total_gross, total_net, total_vat, parsed
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6, $7, $8, $9,
       $10, $11, $12, $13, $14,
       $15, $16, $17, $18,
       $19, $20, COALESCE($21::timestamptz, now()),
       $22, $23, $24,
       $25, $26, $27, $28
     )
     ON CONFLICT (tenant_id, raw_sha256) DO NOTHING
     RETURNING id`,
    [
      tx.tenantId,
      input.inboxId ?? null,
      input.direction ?? "incoming",
      input.sourceChannel,
      input.rawObjectKey,
      input.rawSha256,
      input.sizeBytes,
      input.filename ?? null,
      input.contentType ?? null,
      input.format ?? null,
      input.profileUrn ?? null,
      input.status,
      input.verdictForm ?? "n_a",
      input.verdictContent ?? "n_a",
      input.docTypeCode ?? null,
      input.correctsDocumentId ?? null,
      input.senderAuth === undefined ? null : JSON.stringify(input.senderAuth),
      input.messageId ?? null,
      input.issuedAt ?? null,
      input.dueAt ?? null,
      input.receivedAt ?? null,
      input.supplierName ?? null,
      input.supplierVatId ?? null,
      input.invoiceNumber ?? null,
      input.totalGross ?? null,
      input.totalNet ?? null,
      input.totalVat ?? null,
      input.parsed === undefined || input.parsed === null
        ? null
        : JSON.stringify(input.parsed),
    ],
  );

  const row = inserted.rows[0];
  if (row) return { id: row.id, duplicate: false };

  const existing = await tx.query<{ id: string }>(
    "SELECT id FROM documents WHERE tenant_id = $1 AND raw_sha256 = $2",
    [tx.tenantId, input.rawSha256],
  );
  const found = existing.rows[0];
  if (!found) {
    // Neither inserted nor found: the row belongs to another tenant and RLS is
    // hiding it, or the conflict came from somewhere unexpected. Either way,
    // guessing would be worse than failing.
    throw new Error("Document was neither inserted nor visible after conflict.");
  }
  return { id: found.id, duplicate: true };
}

export async function getDocument(
  tx: TenantClient,
  id: string,
): Promise<DocumentRow | undefined> {
  const { rows } = await tx.query<DocumentRow>("SELECT * FROM documents WHERE id = $1", [id]);
  return rows[0];
}

export async function countDocuments(tx: TenantClient): Promise<number> {
  const { rows } = await tx.query<{ n: string }>("SELECT count(*) AS n FROM documents");
  return Number(rows[0]?.n ?? 0);
}

export interface DocumentListItem {
  id: string;
  supplier_name: string | null;
  invoice_number: string | null;
  issued_at: string | null;
  due_at: string | null;
  total_gross: string | null;
  format: string | null;
  status: string;
  verdict_form: string;
  verdict_content: string;
  received_at: Date;
  finding_count: string;
}

export interface ListFilters {
  status?: string;
  /** Matches supplier name or invoice number. */
  search?: string;
  limit?: number;
}

/**
 * Inbox listing.
 *
 * Reads the denormalised columns rather than digging into `parsed`, so the list
 * stays one index scan even when a tenant has ten years of documents. RLS keeps
 * it to this tenant; there is no tenant_id in the WHERE clause because there
 * must not be one to forget.
 */
export async function listDocuments(
  tx: TenantClient,
  filters: ListFilters = {},
): Promise<DocumentListItem[]> {
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filters.status) {
    values.push(filters.status);
    conditions.push(`status = $${values.length}`);
  }
  if (filters.search?.trim()) {
    values.push(`%${filters.search.trim()}%`);
    conditions.push(`(supplier_name ILIKE $${values.length} OR invoice_number ILIKE $${values.length})`);
  }
  values.push(limit);

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await tx.query<DocumentListItem>(
    `SELECT d.id, d.supplier_name, d.invoice_number, d.issued_at::text, d.due_at::text,
            d.total_gross::text, d.format, d.status, d.verdict_form, d.verdict_content,
            d.received_at,
            (SELECT count(*) FROM findings f WHERE f.document_id = d.id) AS finding_count
       FROM documents d
       ${where}
       ORDER BY d.received_at DESC
       LIMIT $${values.length}`,
    values,
  );
  return rows;
}

export interface StatusCount {
  status: string;
  count: number;
}

export async function countByStatus(tx: TenantClient): Promise<StatusCount[]> {
  const { rows } = await tx.query<{ status: string; n: string }>(
    "SELECT status, count(*) AS n FROM documents GROUP BY status",
  );
  return rows.map((r) => ({ status: r.status, count: Number(r.n) }));
}

export interface FindingRow {
  id: string;
  layer: string;
  code: string;
  severity: string;
  bt_ref: string | null;
  legal_basis: string | null;
  message_raw: string;
  explain_key: string | null;
  params: Record<string, string | number> | null;
  validator_config_version: string;
  engine_version: string;
  ruleset_version: number | null;
}

export async function getFindings(
  tx: TenantClient,
  documentId: string,
): Promise<FindingRow[]> {
  const { rows } = await tx.query<FindingRow>(
    `SELECT id, layer, code, severity, bt_ref, legal_basis, message_raw,
            explain_key, params, validator_config_version, engine_version, ruleset_version
       FROM findings WHERE document_id = $1
       ORDER BY CASE layer
                  WHEN 'l1_schema' THEN 1 WHEN 'l2_schematron' THEN 2
                  WHEN 'l3_domain' THEN 3 ELSE 4 END, code`,
    [documentId],
  );
  return rows;
}

export interface InsertFindingInput {
  documentId: string;
  layer: string;
  code: string;
  severity: string;
  btRef?: string | null;
  legalBasis?: string | null;
  messageRaw: string;
  explainKey?: string | null;
  params?: Record<string, string | number> | null;
  validatorConfigVersion: string;
  engineVersion: string;
  rulesetVersion?: number | null;
}

export async function insertFindings(
  tx: TenantClient,
  findings: InsertFindingInput[],
): Promise<number> {
  let written = 0;
  for (const f of findings) {
    await tx.query(
      `INSERT INTO findings (tenant_id, document_id, layer, code, severity, bt_ref,
                             legal_basis, message_raw, explain_key, params,
                             validator_config_version, engine_version, ruleset_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        tx.tenantId,
        f.documentId,
        f.layer,
        f.code,
        f.severity,
        f.btRef ?? null,
        f.legalBasis ?? null,
        f.messageRaw,
        f.explainKey ?? null,
        f.params ? JSON.stringify(f.params) : null,
        f.validatorConfigVersion,
        f.engineVersion,
        f.rulesetVersion ?? null,
      ],
    );
    written += 1;
  }
  return written;
}

export interface ExportRow {
  id: string;
  supplier_name: string | null;
  invoice_number: string | null;
  issued_at: string | null;
  due_at: string | null;
  total_gross: string | null;
  vat_category: string | null;
  vat_rate: string | null;
  status: string;
}

/**
 * Documents for a bookkeeping export, over a date range.
 *
 * The VAT category and rate are pulled out of `parsed` in SQL rather than by
 * loading every document and digging in TypeScript. They decide which account
 * the posting lands on, and a reverse-charge invoice booked as an ordinary
 * expense claims input tax that was never charged.
 *
 * Only the first breakdown entry is taken. A mixed-rate invoice needs one
 * posting per rate, and splitting it wrongly would be worse than booking it
 * whole where the Steuerberater can see it as one line.
 */
export async function listDocumentsForExport(
  tx: TenantClient,
  range: { from: string; to: string },
): Promise<ExportRow[]> {
  const { rows } = await tx.query<ExportRow>(
    `SELECT id, supplier_name, invoice_number,
            issued_at::text, due_at::text, total_gross::text, status,
            parsed -> 'taxBreakdown' -> 0 ->> 'category' AS vat_category,
            parsed -> 'taxBreakdown' -> 0 ->> 'rate'     AS vat_rate
       FROM documents
      WHERE issued_at BETWEEN $1::date AND $2::date
        AND direction = 'incoming'
      ORDER BY issued_at, invoice_number`,
    [range.from, range.to],
  );
  return rows;
}
