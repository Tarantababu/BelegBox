import type { TenantClient } from "./client.js";
import type { DocumentListItem } from "./documents.js";

/**
 * M-05. Search across the archive.
 *
 * The dangerous failure is not a slow search, it is an empty one. Ten years in,
 * a user who searches for an invoice and sees nothing concludes it never
 * arrived - and books, pays or disputes on that basis. So this returns a total
 * rather than only a page, it says which kind of match produced the rows, and
 * it falls back to near matches instead of an empty list when nothing matches
 * exactly. What it never does is present a near match as though it were exact.
 */

export type SearchMode = "exact" | "similar" | "filtered";

export interface SearchQuery {
  /** Free text: supplier, invoice number, VAT id, or an amount. */
  q?: string | undefined;
  status?: string | undefined;
  direction?: "incoming" | "outgoing" | undefined;
  /** Issue date (BT-2), inclusive, as YYYY-MM-DD. */
  issuedFrom?: string | undefined;
  issuedTo?: string | undefined;
  minGross?: number | undefined;
  maxGross?: number | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface SearchHit extends DocumentListItem {
  /** 0 exact invoice number, 1 supplier prefix, 2 anything else. */
  rank: number;
}

export interface SearchResult {
  hits: SearchHit[];
  /**
   * Matches in the whole archive, not on this page.
   *
   * Counted only up to `COUNT_CAP`. A precise total means visiting every
   * matching row, and a query like "GmbH" matches most of a ten-year archive -
   * so the count is bounded and says when it is a floor rather than growing
   * without limit on the one screen that must stay usable.
   */
  total: number;
  /** True when there are more matches than `total`. */
  totalIsLowerBound: boolean;
  mode: SearchMode;
  limit: number;
  offset: number;
  /**
   * The amount the query was read as, when it parsed as one.
   *
   * Reported so the caller can say so: a user typing "4200" and getting the
   * 4.200,00 EUR invoice should be able to see that is why.
   */
  amount: number | null;
}

const MAX_LIMIT = 200;

/**
 * How far the total is counted before it is reported as "more than this".
 *
 * A user deciding whether an invoice exists needs an exact small number; a user
 * who matched a third of the archive needs to narrow the search, and the exact
 * figure would not change what they do next.
 */
export const COUNT_CAP = 1000;

/**
 * Reads a query as an amount, if it is one.
 *
 * German notation is the default here - "4.200,00" is four thousand two
 * hundred, not four point two. A query that is ambiguous under both readings
 * ("4.200") is taken as German, because that is what a German invoice shows.
 */
export function parseAmount(raw: string): number | null {
  const value = raw.trim().replace(/\s|€|EUR/gi, "");
  if (!value) return null;

  // 1.234.567,89 - German grouping with a decimal comma.
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(value)) {
    return Number(value.replace(/\./g, "").replace(",", "."));
  }
  // 4200,00 or 4200.00 or 4200
  if (/^\d+([.,]\d{1,2})?$/.test(value)) {
    return Number(value.replace(",", "."));
  }
  return null;
}

const SELECT = `
  SELECT d.id, d.supplier_name, d.invoice_number, d.issued_at::text, d.due_at::text,
         d.total_gross::text, d.format, d.status, d.verdict_form, d.verdict_content,
         d.received_at,
         (SELECT count(*) FROM findings f WHERE f.document_id = d.id) AS finding_count`;

interface Builder {
  conditions: string[];
  values: unknown[];
}

/** Adds a bound value and returns its placeholder. */
function bind(builder: Builder, value: unknown): string {
  builder.values.push(value);
  return `$${builder.values.length}`;
}

function applyFilters(builder: Builder, query: SearchQuery): void {
  if (query.status) {
    builder.conditions.push(`d.status = ${bind(builder, query.status)}`);
  }
  if (query.direction) {
    builder.conditions.push(`d.direction = ${bind(builder, query.direction)}`);
  }
  // R-1's habit: a period means the document's own issue date, never when it
  // happened to be received.
  if (query.issuedFrom) {
    builder.conditions.push(`d.issued_at >= ${bind(builder, query.issuedFrom)}::date`);
  }
  if (query.issuedTo) {
    builder.conditions.push(`d.issued_at <= ${bind(builder, query.issuedTo)}::date`);
  }
  if (query.minGross !== undefined) {
    builder.conditions.push(`d.total_gross >= ${bind(builder, query.minGross)}`);
  }
  if (query.maxGross !== undefined) {
    builder.conditions.push(`d.total_gross <= ${bind(builder, query.maxGross)}`);
  }
}

/**
 * Counts matches, stopping at the cap.
 *
 * The LIMIT is inside the subquery so the planner stops reading once it has
 * enough rows, rather than counting the whole match set and discarding the
 * excess.
 */
async function countMatches(
  tx: TenantClient,
  where: string,
  values: unknown[],
): Promise<{ total: number; totalIsLowerBound: boolean }> {
  const { rows } = await tx.query<{ n: string }>(
    `SELECT count(*) AS n
       FROM (SELECT 1 FROM documents d ${where} LIMIT ${COUNT_CAP + 1}) capped`,
    values,
  );
  const counted = Number(rows[0]?.n ?? 0);
  return counted > COUNT_CAP
    ? { total: COUNT_CAP, totalIsLowerBound: true }
    : { total: counted, totalIsLowerBound: false };
}

export async function searchDocuments(
  tx: TenantClient,
  query: SearchQuery = {},
): Promise<SearchResult> {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), MAX_LIMIT);
  const offset = Math.max(query.offset ?? 0, 0);
  const term = query.q?.trim() ?? "";

  // No text: this is a filtered browse, and saying so keeps the caller from
  // reporting "no matches for your search" when nothing was searched for.
  if (!term) {
    const builder: Builder = { conditions: [], values: [] };
    applyFilters(builder, query);
    const where = builder.conditions.length ? `WHERE ${builder.conditions.join(" AND ")}` : "";

    const filterValues = [...builder.values];
    const { rows } = await tx.query<SearchHit>(
      `${SELECT}, 2 AS rank
         FROM documents d
         ${where}
         ORDER BY d.received_at DESC
         LIMIT ${bind(builder, limit)} OFFSET ${bind(builder, offset)}`,
      builder.values,
    );
    const counted = await countMatches(tx, where, filterValues);

    return {
      hits: rows.map((hit) => ({ ...hit, rank: Number(hit.rank) })),
      ...counted,
      mode: "filtered",
      limit,
      offset,
      amount: null,
    };
  }

  const amount = parseAmount(term);

  const exact = await runTextSearch(tx, query, term, amount, limit, offset, "exact");
  if (exact.hits.length > 0 || offset > 0) {
    // An empty page beyond the first is the end of the results, not a reason to
    // start guessing at different documents.
    return exact;
  }

  return runTextSearch(tx, query, term, amount, limit, offset, "similar");
}

async function runTextSearch(
  tx: TenantClient,
  query: SearchQuery,
  term: string,
  amount: number | null,
  limit: number,
  offset: number,
  mode: "exact" | "similar",
): Promise<SearchResult> {
  const builder: Builder = { conditions: [], values: [] };
  applyFilters(builder, query);

  // Both foldings of the query, computed by the same functions that built
  // search_text. One definition, so the two sides cannot drift apart.
  const raw = bind(builder, term);
  const de = `belegbox_fold_de(${raw})`;
  const ascii = `belegbox_fold_ascii(${raw})`;

  const matches: string[] = [];
  if (mode === "exact") {
    matches.push(`d.search_text LIKE '%' || ${de} || '%'`);
    matches.push(`d.search_text LIKE '%' || ${ascii} || '%'`);
  } else {
    // word_similarity, not similarity: search_text holds every searchable field
    // twice, so a short query compared against the whole string scores near
    // zero however well it matches the supplier name inside it.
    matches.push(`${de} <% d.search_text`);
    matches.push(`${ascii} <% d.search_text`);
  }
  if (amount !== null) {
    matches.push(`d.total_gross = ${bind(builder, amount)}`);
  }

  builder.conditions.push(`(${matches.join(" OR ")})`);

  const rank = `CASE
      WHEN belegbox_fold_ascii(coalesce(d.invoice_number, '')) = ${ascii} THEN 0
      WHEN belegbox_fold_ascii(coalesce(d.supplier_name, '')) LIKE ${ascii} || '%' THEN 1
      ELSE 2
    END`;

  const order =
    mode === "exact"
      ? `ORDER BY rank, d.received_at DESC`
      : `ORDER BY word_similarity(${ascii}, d.search_text) DESC, d.received_at DESC`;

  const where = `WHERE ${builder.conditions.join(" AND ")}`;
  const filterValues = [...builder.values];

  const { rows } = await tx.query<SearchHit>(
    `${SELECT}, ${rank} AS rank
       FROM documents d
       ${where}
       ${order}
       LIMIT ${bind(builder, limit)} OFFSET ${bind(builder, offset)}`,
    builder.values,
  );
  const counted = await countMatches(tx, where, filterValues);

  return {
    hits: rows.map((hit) => ({ ...hit, rank: Number(hit.rank) })),
    ...counted,
    mode,
    limit,
    offset,
    amount,
  };
}
