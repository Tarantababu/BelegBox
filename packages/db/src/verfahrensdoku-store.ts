import type { TenantClient } from "./client.js";

/**
 * Reads and writes the fassungen of the Verfahrensdokumentation.
 *
 * The table is append-only, so there is no update here and there never will be:
 * a correction is a new fassung, chained to the one it supersedes.
 */

export interface DokuVersionRow {
  id: string;
  version: number;
  content_hash: string;
  prev_hash: string | null;
  open_items: number;
  complete: boolean;
  generated_at: Date;
}

export interface StoreDokuInput {
  version: number;
  contentHash: string;
  prevHash: string | null;
  /** The input the fassung was generated from, so it can be re-derived. */
  facts: unknown;
  html: string;
  openItems: number;
  complete: boolean;
  generatedBy?: string | undefined;
}

/**
 * The fassung this one will follow.
 *
 * Read inside the same transaction as the insert, so two concurrent generations
 * cannot both claim to be fassung 4 - the UNIQUE (tenant_id, version) refuses
 * the loser rather than letting the chain fork.
 */
export async function latestDoku(
  tx: TenantClient,
): Promise<DokuVersionRow | undefined> {
  const { rows } = await tx.query<DokuVersionRow>(
    `SELECT id, version, content_hash, prev_hash, open_items, complete, generated_at
       FROM verfahrensdokumentationen
      ORDER BY version DESC
      LIMIT 1`,
  );
  return rows[0];
}

export async function listDoku(tx: TenantClient): Promise<DokuVersionRow[]> {
  const { rows } = await tx.query<DokuVersionRow>(
    `SELECT id, version, content_hash, prev_hash, open_items, complete, generated_at
       FROM verfahrensdokumentationen
      ORDER BY version DESC`,
  );
  return rows;
}

export async function getDokuHtml(
  tx: TenantClient,
  version: number,
): Promise<{ html: string; content_hash: string; generated_at: Date } | undefined> {
  const { rows } = await tx.query<{ html: string; content_hash: string; generated_at: Date }>(
    `SELECT html, content_hash, generated_at
       FROM verfahrensdokumentationen
      WHERE version = $1`,
    [version],
  );
  return rows[0];
}

export async function insertDoku(
  tx: TenantClient,
  input: StoreDokuInput,
): Promise<DokuVersionRow> {
  const { rows } = await tx.query<DokuVersionRow>(
    `INSERT INTO verfahrensdokumentationen
       (tenant_id, version, content_hash, prev_hash, facts, html,
        open_items, complete, generated_by)
     VALUES (current_tenant_id(), $1, $2, $3, $4::jsonb, $5, $6, $7, $8)
     RETURNING id, version, content_hash, prev_hash, open_items, complete, generated_at`,
    [
      input.version,
      input.contentHash,
      input.prevHash,
      JSON.stringify(input.facts),
      input.html,
      input.openItems,
      input.complete,
      input.generatedBy ?? null,
    ],
  );

  const row = rows[0];
  if (!row) throw new Error("insertDoku returned no row");
  return row;
}

/**
 * Walks the chain from fassung 1 forward.
 *
 * The same check `verifyChain` does for archive days. A fassung whose
 * `prev_hash` does not match its predecessor's `content_hash` means a stored
 * fassung was altered after the fact, which is the one thing the history is
 * supposed to make visible.
 */
export function verifyDokuChain(
  rows: DokuVersionRow[],
): { ok: true } | { ok: false; brokenAt: number } {
  const ordered = [...rows].sort((a, b) => a.version - b.version);

  for (const [index, row] of ordered.entries()) {
    const previous = ordered[index - 1];
    const expected = previous ? previous.content_hash : null;
    if (row.prev_hash !== expected) {
      return { ok: false, brokenAt: row.version };
    }
  }
  return { ok: true };
}
