import {
  buildBuchungsstapel,
  chartFor,
  datevFilename,
  type DatevBooking,
} from "@belegbox/datev";
import { getTenant, listDocumentsForExport, type Db } from "@belegbox/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface DatevRouteDeps {
  db: Db;
  resolveTenant: (request: FastifyRequest) => Promise<string | undefined>;
}

interface ExportBody {
  from?: string;
  to?: string;
  beraterNumber?: number;
  mandantNumber?: number;
  fiscalYearStart?: string;
  accountLength?: number;
  chart?: string;
}

export function registerDatevRoutes(app: FastifyInstance, deps: DatevRouteDeps): void {
  /**
   * M-06. The monthly hand-off to the Steuerberater.
   *
   * Included in every paid tier. The PRD makes that a deliberate difference
   * from the competitor, who puts it behind the top plan - so there is no
   * entitlement check here, and there should not be one.
   */
  app.post<{ Body: ExportBody }>("/v1/exports/datev", async (request, reply) => {
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

    // The consultant and client numbers belong to the Steuerberater, not to
    // us, and DATEV rejects a file addressed to the wrong practice.
    if (!body.beraterNumber || !body.mandantNumber) {
      return reply.code(400).send({
        error: "beraterNumber and mandantNumber are required",
        message:
          "Diese Nummern vergibt deine Steuerberatung. Ohne sie kann DATEV den Stapel nicht zuordnen.",
      });
    }

    const from = new Date(`${body.from}T00:00:00Z`);
    const to = new Date(`${body.to}T00:00:00Z`);
    const fiscalYearStart = body.fiscalYearStart && ISO_DATE.test(body.fiscalYearStart)
      ? new Date(`${body.fiscalYearStart}T00:00:00Z`)
      : new Date(Date.UTC(from.getUTCFullYear(), 0, 1));

    return deps.db.withTenant(tenantId, async (tx) => {
      const tenant = await getTenant(tx);
      const documents = await listDocumentsForExport(tx, {
        from: body.from as string,
        to: body.to as string,
      });

      const bookings: DatevBooking[] = [];
      const skipped: Array<{ id: string; reason: string }> = [];

      for (const document of documents) {
        if (document.total_gross === null || !document.issued_at) {
          // A document with no amount or no date is not a posting. Exporting it
          // as zero would put a line in the books that means nothing.
          skipped.push({ id: document.id, reason: "no_amount_or_date" });
          continue;
        }
        if (document.status === "not_einvoice") {
          // Kept for § 14b, but there is no structured amount to book from.
          skipped.push({ id: document.id, reason: "not_an_einvoice" });
          continue;
        }

        bookings.push({
          grossAmount: Number(document.total_gross),
          debitCredit: "S",
          documentDate: new Date(`${document.issued_at}T00:00:00Z`),
          invoiceNumber: document.invoice_number,
          text: document.supplier_name ?? "Unbekannter Lieferant",
          vatCategory: document.vat_category,
          vatRate: document.vat_rate === null ? null : Number(document.vat_rate),
          ...(document.due_at ? { dueDate: new Date(`${document.due_at}T00:00:00Z`) } : {}),
        });
      }

      const options = {
        beraterNumber: body.beraterNumber as number,
        mandantNumber: body.mandantNumber as number,
        fiscalYearStart,
        periodFrom: from,
        periodTo: to,
        ...(body.accountLength ? { accountLength: body.accountLength } : {}),
        accounts: chartFor(body.chart ?? null),
        description: `Belegbox ${tenant?.name ?? ""}`.trim().slice(0, 30),
        createdBy: "Belegbox",
      };

      try {
        const file = buildBuchungsstapel(bookings, options);
        return reply.send({
          filename: datevFilename(options),
          encoding: "windows-1252",
          bookings: bookings.length,
          skipped,
          chart: options.accounts.chart,
          // Base64 because the file is Windows-1252 and JSON is UTF-8; sending
          // it as a string would re-encode every umlaut on the way out.
          contentBase64: file.toString("base64"),
        });
      } catch (err) {
        return reply.code(422).send({ error: "unbuildable", message: (err as Error).message });
      }
    });
  });
}
