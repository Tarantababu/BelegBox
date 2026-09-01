import { buildBelegBundle, BundleError, type BelegSource } from "@belegbox/beleg-export";
import { getTenant, listBelegeForBundle, type Db } from "@belegbox/db";
import type { ObjectStore } from "@belegbox/storage";
import type { FastifyInstance, FastifyRequest } from "fastify";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface BelegeRouteDeps {
  db: Db;
  storage: ObjectStore;
  resolveTenant: (request: FastifyRequest) => Promise<string | undefined>;
}

interface BundleBody {
  from?: string;
  to?: string;
}

/**
 * M-06, second half. The originals that belong with the Buchungsstapel.
 *
 * Returned as binary rather than base64, unlike the DATEV file: a ZIP is
 * already bytes with no encoding to preserve, and a period of originals is
 * large enough that base64's third of overhead is worth avoiding.
 *
 * The outcome of the run - what went in, what did not, and why - travels in
 * response headers, because the body is the file. A caller that needs the
 * detail reads the manifest inside the ZIP, which carries the same information
 * in the form the recipient sees.
 */
export function registerBelegeRoutes(app: FastifyInstance, deps: BelegeRouteDeps): void {
  app.post<{ Body: BundleBody }>("/v1/exports/belege", async (request, reply) => {
    const tenantId = await deps.resolveTenant(request);
    if (!tenantId) return reply.code(401).send({ error: "unauthorized" });

    const body = request.body ?? {};
    for (const field of ["from", "to"] as const) {
      if (!body[field] || !ISO_DATE.test(body[field] as string)) {
        return reply.code(400).send({ error: `${field} must be a YYYY-MM-DD date` });
      }
    }
    if ((body.from as string) > (body.to as string)) {
      return reply.code(400).send({ error: "from must not be after to" });
    }

    const from = body.from as string;
    const to = body.to as string;

    const documents = await deps.db.withTenant(tenantId, async (tx) => {
      const tenant = await getTenant(tx);
      const rows = await listBelegeForBundle(tx, { from, to });
      return { tenantName: tenant?.name ?? "Belegbox", rows };
    });

    if (documents.rows.length === 0) {
      return reply.code(404).send({
        error: "no_documents",
        message: "Für diesen Zeitraum gibt es keine Belege.",
      });
    }

    const sources: BelegSource[] = documents.rows.map((row) => ({
      id: row.id,
      rawObjectKey: row.raw_object_key,
      rawSha256: row.raw_sha256,
      sizeBytes: Number(row.size_bytes),
      supplierName: row.supplier_name,
      invoiceNumber: row.invoice_number,
      issuedAt: row.issued_at,
      totalGross: row.total_gross,
      status: row.status,
      format: row.format,
      contentType: row.content_type,
      receivedAt: row.received_at,
      archiveDay: row.archive_day,
      merkleRoot: row.merkle_root,
    }));

    try {
      const bundle = await buildBelegBundle(deps.storage, {
        tenantName: documents.tenantName,
        from,
        to,
        documents: sources,
      });

      // A hash mismatch means the stored bytes are not the archived bytes. The
      // bundle still goes out - the documents that are intact are the ones the
      // Steuerberater needs - but the caller is told, and so is the manifest.
      const mismatches = bundle.skipped.filter((entry) => entry.reason === "hash_mismatch");
      if (mismatches.length > 0) {
        request.log.error(
          { tenantId, documentIds: mismatches.map((entry) => entry.documentId) },
          "archive integrity: stored bytes do not match the archived digest",
        );
      }

      return reply
        .header("content-type", "application/zip")
        .header("content-disposition", `attachment; filename="${bundle.filename}"`)
        .header("cache-control", "no-store")
        .header("x-belegbox-included", String(bundle.included.length))
        .header("x-belegbox-skipped", String(bundle.skipped.length))
        .header("x-belegbox-integrity-failures", String(mismatches.length))
        .header("x-belegbox-bundle-sha256", bundle.sha256)
        .send(bundle.bytes);
    } catch (cause) {
      if (cause instanceof BundleError) {
        return reply.code(400).send({ error: "bundle_failed", message: cause.message });
      }
      throw cause;
    }
  });
}
