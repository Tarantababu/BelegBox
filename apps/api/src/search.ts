import { searchDocuments, type Db, type SearchQuery } from "@belegbox/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface SearchRouteDeps {
  db: Db;
  resolveTenant: (request: FastifyRequest) => Promise<string | undefined>;
  statuses: ReadonlySet<string>;
}

interface SearchParams {
  q?: string;
  status?: string;
  direction?: string;
  from?: string;
  to?: string;
  min?: string;
  max?: string;
  limit?: string;
  offset?: string;
}

function positiveNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * M-05. Search across the archive.
 *
 * A GET, because a search is a read and users bookmark and share the URL of
 * one. Everything the caller asked for comes back in the response, so a stored
 * link is self-describing.
 */
export function registerSearchRoutes(app: FastifyInstance, deps: SearchRouteDeps): void {
  app.get<{ Querystring: SearchParams }>("/v1/documents/search", async (request, reply) => {
    const tenantId = await deps.resolveTenant(request);
    if (!tenantId) return reply.code(401).send({ error: "unauthorized" });

    const params = request.query;

    if (params.status && !deps.statuses.has(params.status)) {
      return reply.code(400).send({ error: `unknown status "${params.status}"` });
    }
    if (params.direction && params.direction !== "incoming" && params.direction !== "outgoing") {
      return reply.code(400).send({ error: `unknown direction "${params.direction}"` });
    }
    for (const field of ["from", "to"] as const) {
      const value = params[field];
      if (value && !ISO_DATE.test(value)) {
        return reply.code(400).send({ error: `${field} must be a YYYY-MM-DD date` });
      }
    }
    // Refused rather than silently swapped: a period the caller did not mean
    // returns documents they did not ask for, and they have no way to tell.
    if (params.from && params.to && params.from > params.to) {
      return reply.code(400).send({ error: "from must not be after to" });
    }

    const query: SearchQuery = {
      ...(params.q ? { q: params.q } : {}),
      ...(params.status ? { status: params.status } : {}),
      ...(params.direction ? { direction: params.direction as "incoming" | "outgoing" } : {}),
      ...(params.from ? { issuedFrom: params.from } : {}),
      ...(params.to ? { issuedTo: params.to } : {}),
      ...(positiveNumber(params.min) !== undefined ? { minGross: positiveNumber(params.min) } : {}),
      ...(positiveNumber(params.max) !== undefined ? { maxGross: positiveNumber(params.max) } : {}),
      ...(positiveNumber(params.limit) !== undefined ? { limit: positiveNumber(params.limit) } : {}),
      ...(positiveNumber(params.offset) !== undefined ? { offset: positiveNumber(params.offset) } : {}),
    };

    return deps.db.withTenant(tenantId, async (tx) => {
      const result = await searchDocuments(tx, query);

      return reply.send({
        // Named so a caller cannot mistake a near match for an exact one, and
        // so an empty result reads as "not in the archive" rather than as a
        // failed search.
        mode: result.mode,
        total: result.total,
        totalIsLowerBound: result.totalIsLowerBound,
        limit: result.limit,
        offset: result.offset,
        amount: result.amount,
        documents: result.hits.map((hit) => ({
          id: hit.id,
          supplier: hit.supplier_name,
          invoiceNumber: hit.invoice_number,
          issuedAt: hit.issued_at,
          dueAt: hit.due_at,
          totalGross: hit.total_gross === null ? null : Number(hit.total_gross),
          format: hit.format,
          status: hit.status,
          verdict: { form: hit.verdict_form, content: hit.verdict_content },
          findingCount: Number(hit.finding_count),
          receivedAt: hit.received_at.toISOString(),
        })),
      });
    });
  });
}
