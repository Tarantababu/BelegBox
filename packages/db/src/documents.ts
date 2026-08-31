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
}

export interface DocumentRow {
  id: string;
  tenant_id: string;
  raw_sha256: string;
  raw_object_key: string;
  size_bytes: string;
  status: string;
  format: string | null;
  profile_urn: string | null;
  archived_at: Date | null;
  archive_hash: string | null;
  received_at: Date;
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
       issued_at, due_at, received_at
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6, $7, $8, $9,
       $10, $11, $12, $13, $14,
       $15, $16, $17, $18,
       $19, $20, COALESCE($21::timestamptz, now())
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
