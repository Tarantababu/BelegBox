import {
  entryLeafHash,
  hex,
  proveInclusion,
  sealDay,
  verifyChain,
  type ArchiveEntry,
  type ChainLink,
  type InclusionProof,
} from "@belegbox/archive";
import type { TenantClient } from "./client.js";

/** YYYY-MM-DD in UTC. Sealing has to agree on a day boundary; UTC is the one. */
export function utcDay(at: Date | string): string {
  const d = typeof at === "string" ? new Date(at) : at;
  return d.toISOString().slice(0, 10);
}

interface DocRow {
  id: string;
  tenant_id: string;
  raw_sha256: string;
  size_bytes: string;
  archived_at: Date;
}

function toEntry(row: DocRow): ArchiveEntry {
  return {
    documentId: row.id,
    tenantId: row.tenant_id,
    sha256: row.raw_sha256,
    sizeBytes: Number(row.size_bytes),
    archivedAt: row.archived_at.toISOString(),
  };
}

/**
 * Writes a document into the archive.
 *
 * Refuses if the day it would land in is already sealed. Admitting a document
 * to a sealed day would leave it outside the Merkle tree that covers that day -
 * present in the database, absent from the proof. A hole like that is exactly
 * what an auditor is looking for, so it is made impossible rather than
 * detected later.
 */
export async function archiveDocument(
  tx: TenantClient,
  documentId: string,
  opts: { retentionYears?: number; archivedAt?: Date } = {},
): Promise<{ archivedAt: string; leafHash: string; day: string }> {
  const archivedAt = opts.archivedAt ?? new Date();
  const day = utcDay(archivedAt);

  const sealed = await tx.query<{ day: string }>(
    "SELECT day FROM archive_chain WHERE tenant_id = $1 AND day = $2",
    [tx.tenantId, day],
  );
  if (sealed.rows.length > 0) {
    throw new Error(
      `${day} is already sealed for this tenant; a document cannot be added to a sealed day.`,
    );
  }

  const { rows } = await tx.query<DocRow>(
    `UPDATE documents
        SET archived_at = $2,
            retention_until = ($2::timestamptz + make_interval(years => $3))::date
      WHERE id = $1 AND archived_at IS NULL
      RETURNING id, tenant_id, raw_sha256, size_bytes, archived_at`,
    [documentId, archivedAt.toISOString(), opts.retentionYears ?? 10],
  );

  const row = rows[0];
  if (!row) {
    throw new Error(`Document ${documentId} is missing, not visible, or already archived.`);
  }

  const leafHash = hex(entryLeafHash(toEntry(row)));
  await tx.query("UPDATE documents SET archive_hash = $2 WHERE id = $1", [documentId, leafHash]);

  return { archivedAt: row.archived_at.toISOString(), leafHash, day };
}

export async function entriesForDay(tx: TenantClient, day: string): Promise<ArchiveEntry[]> {
  const { rows } = await tx.query<DocRow>(
    `SELECT id, tenant_id, raw_sha256, size_bytes, archived_at
       FROM documents
      WHERE archived_at IS NOT NULL
        AND (archived_at AT TIME ZONE 'UTC')::date = $1::date
      ORDER BY archived_at, id`,
    [day],
  );
  return rows.map(toEntry);
}

function rowToLink(r: {
  day: Date | string;
  tenant_id: string;
  merkle_root: string;
  prev_root: string | null;
  tree_size: number;
  sealed_at: Date;
}): ChainLink {
  return {
    day: typeof r.day === "string" ? r.day : utcDay(r.day),
    tenantId: r.tenant_id,
    merkleRoot: r.merkle_root,
    prevRoot: r.prev_root,
    treeSize: Number(r.tree_size),
    sealedAt: r.sealed_at.toISOString(),
  };
}

export async function chainLinks(tx: TenantClient): Promise<ChainLink[]> {
  const { rows } = await tx.query<Parameters<typeof rowToLink>[0]>(
    "SELECT * FROM archive_chain WHERE tenant_id = $1 ORDER BY day",
    [tx.tenantId],
  );
  return rows.map(rowToLink);
}

export async function linkForDay(
  tx: TenantClient,
  day: string,
): Promise<ChainLink | undefined> {
  const { rows } = await tx.query<Parameters<typeof rowToLink>[0]>(
    "SELECT * FROM archive_chain WHERE tenant_id = $1 AND day = $2",
    [tx.tenantId, day],
  );
  const row = rows[0];
  return row ? rowToLink(row) : undefined;
}

/**
 * Seals one day into the chain.
 *
 * Idempotent, and forward-only: a day at or before the last sealed day is
 * refused. Sealing backwards would rewrite the chain that later days already
 * point at.
 */
export async function sealArchiveDay(
  tx: TenantClient,
  day: string,
  sealedAt = new Date(),
): Promise<{ link: ChainLink; alreadySealed: boolean }> {
  const existing = await linkForDay(tx, day);
  if (existing) return { link: existing, alreadySealed: true };

  const { rows: prevRows } = await tx.query<Parameters<typeof rowToLink>[0]>(
    "SELECT * FROM archive_chain WHERE tenant_id = $1 ORDER BY day DESC LIMIT 1",
    [tx.tenantId],
  );
  const previous = prevRows[0] ? rowToLink(prevRows[0]) : undefined;

  if (previous && day <= previous.day) {
    throw new Error(
      `Cannot seal ${day}: ${previous.day} is already sealed, and the chain only moves forward.`,
    );
  }

  const { link } = sealDay({
    day,
    tenantId: tx.tenantId,
    entries: await entriesForDay(tx, day),
    prevRoot: previous?.merkleRoot ?? null,
    sealedAt: sealedAt.toISOString(),
  });

  await tx.query(
    `INSERT INTO archive_chain (day, tenant_id, merkle_root, prev_root, tree_size, sealed_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [link.day, link.tenantId, link.merkleRoot, link.prevRoot, link.treeSize, link.sealedAt],
  );

  return { link, alreadySealed: false };
}

export interface ArchiveProof {
  entry: ArchiveEntry;
  proof: InclusionProof;
  link: ChainLink;
  /** The tenant's chain up to and including the proving day. */
  chain: ChainLink[];
  chainValid: boolean;
}

/**
 * Builds the integrity proof for one document.
 *
 * Returns undefined when the document is not visible to this tenant - which,
 * under RLS, is the same answer as "does not exist". That is deliberate: a
 * distinguishable "exists but not yours" would leak the existence of another
 * tenant's document.
 */
export async function proofForDocument(
  tx: TenantClient,
  documentId: string,
): Promise<ArchiveProof | undefined> {
  const { rows } = await tx.query<DocRow & { archived_at: Date | null }>(
    `SELECT id, tenant_id, raw_sha256, size_bytes, archived_at
       FROM documents WHERE id = $1`,
    [documentId],
  );
  const row = rows[0];
  if (!row?.archived_at) return undefined;

  const day = utcDay(row.archived_at);
  const link = await linkForDay(tx, day);
  if (!link) return undefined;

  const entries = await entriesForDay(tx, day);
  const proof = proveInclusion(entries, documentId, link);

  const chain = (await chainLinks(tx)).filter((l) => l.day <= day);
  return {
    entry: toEntry(row as DocRow),
    proof,
    link,
    chain,
    chainValid: verifyChain(chain).valid,
  };
}
