import {
  buildSepaFile,
  renderGiroCodeSvg,
  sepaFilename,
  type PainVersion,
} from "@belegbox/payments";
import { getDocument, getTenant, type Db } from "@belegbox/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSIONS = new Set(["pain.001.001.03", "pain.001.001.09"]);

/**
 * The sentence that keeps this out of ZAG § 1 Abs. 1 Nr. 7.
 *
 * Belegbox produces payment data. The user carries it to their own bank. No
 * money moves through anything here, there is no write access to an account,
 * and nothing is initiated on anyone's behalf - which is the difference between
 * a file generator and a payment initiation service needing BaFin
 * authorisation and 50.000 EUR of capital.
 */
export const PAYMENT_DISCLAIMER = {
  de: "Das ist kein Zahlungsdienst. Belegbox erzeugt nur Zahlungsdaten - überwiesen wird von dir, in deiner Bank.",
  tr: "Bu bir ödeme hizmeti değildir. Belegbox yalnızca ödeme verisi üretir; havaleyi kendi bankanda sen yaparsın.",
} as const;

export interface PaymentRouteDeps {
  db: Db;
  resolveTenant: (request: FastifyRequest) => Promise<string | undefined>;
}

interface PaymentSource {
  supplier: string;
  iban: string;
  amount: number;
  reference: string;
}

/**
 * Reads the payment details off a document.
 *
 * Everything comes from the parsed invoice rather than being supplied by the
 * caller. An endpoint that took an IBAN as input would happily encode one an
 * attacker chose, and D-008 exists because a swapped IBAN is the commonest
 * shape of invoice fraud.
 */
function paymentSource(parsed: unknown, fallbackName: string | null): PaymentSource | undefined {
  const invoice = parsed as
    | {
        payment?: { iban?: string; reference?: string };
        seller?: { name?: string };
        totals?: { payable?: number; taxInclusive?: number };
        invoiceNumber?: string;
      }
    | null;

  const iban = invoice?.payment?.iban;
  const amount = invoice?.totals?.payable ?? invoice?.totals?.taxInclusive;
  if (!iban || amount === undefined) return undefined;

  return {
    supplier: invoice?.seller?.name ?? fallbackName ?? "Unbekannter Empfänger",
    iban,
    amount,
    reference: invoice?.payment?.reference ?? invoice?.invoiceNumber ?? "",
  };
}

export function registerPaymentRoutes(app: FastifyInstance, deps: PaymentRouteDeps): void {
  /** M-04. The QR the user scans with their own banking app. */
  app.get<{ Params: { id: string } }>(
    "/v1/documents/:id/girocode",
    async (request, reply) => {
      const tenantId = await deps.resolveTenant(request);
      if (!tenantId) return reply.code(401).send({ error: "unauthorized" });

      const { id } = request.params;
      if (!UUID.test(id)) return reply.code(400).send({ error: "document id must be a UUID" });

      return deps.db.withTenant(tenantId, async (tx) => {
        const document = await getDocument(tx, id);
        if (!document) return reply.code(404).send({ error: "not found" });

        const source = paymentSource(document.parsed, document.supplier_name);
        if (!source) {
          return reply.code(409).send({
            error: "no_payment_details",
            message:
              "Dieser Beleg enthält keine Kontoverbindung oder keinen Betrag, aus denen sich eine Zahlung erzeugen lässt.",
          });
        }

        try {
          const rendered = await renderGiroCodeSvg({
            beneficiaryName: source.supplier,
            iban: source.iban,
            amount: source.amount,
            remittance: source.reference,
          });

          return reply.send({
            ...rendered,
            beneficiary: source.supplier,
            iban: source.iban,
            amount: source.amount,
            reference: source.reference,
            disclaimer: PAYMENT_DISCLAIMER,
          });
        } catch (err) {
          // A refusal here is the point - an unencodable IBAN must not become a
          // QR someone scans into a payment screen.
          return reply.code(422).send({ error: "unencodable", message: (err as Error).message });
        }
      });
    },
  );

  /** M-04. The file the user uploads to their own online banking. */
  app.post<{ Body: { documentIds?: string[]; version?: string; debtorIban?: string; debtorBic?: string } }>(
    "/v1/payments/sepa-file",
    async (request, reply) => {
      const tenantId = await deps.resolveTenant(request);
      if (!tenantId) return reply.code(401).send({ error: "unauthorized" });

      const ids = request.body?.documentIds ?? [];
      if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => !UUID.test(id))) {
        return reply.code(400).send({ error: "documentIds must be a non-empty list of UUIDs" });
      }
      if (ids.length > 500) {
        return reply.code(400).send({ error: "at most 500 documents per file" });
      }

      const version = request.body?.version ?? "pain.001.001.03";
      if (!VERSIONS.has(version)) {
        return reply.code(400).send({
          error: `version must be one of ${[...VERSIONS].join(", ")}`,
        });
      }

      const debtorIban = request.body?.debtorIban;
      if (!debtorIban) {
        // The debtor account is the user's own, and Belegbox never learns it
        // from a document. Asking is the only honest option.
        return reply.code(400).send({ error: "debtorIban is required" });
      }

      return deps.db.withTenant(tenantId, async (tx) => {
        const tenant = await getTenant(tx);
        const transfers = [];
        const skipped: Array<{ id: string; reason: string }> = [];

        for (const id of ids) {
          const document = await getDocument(tx, id);
          // A document belonging to another tenant is simply absent here; RLS
          // already made it so.
          if (!document) {
            skipped.push({ id, reason: "not_found" });
            continue;
          }
          const source = paymentSource(document.parsed, document.supplier_name);
          if (!source) {
            skipped.push({ id, reason: "no_payment_details" });
            continue;
          }
          transfers.push({
            endToEndId: source.reference,
            creditorName: source.supplier,
            creditorIban: source.iban,
            amount: source.amount,
            remittance: source.reference,
          });
        }

        if (transfers.length === 0) {
          return reply.code(409).send({ error: "no_payable_documents", skipped });
        }

        try {
          const xml = buildSepaFile({
            debtor: {
              name: tenant?.name ?? "Belegbox",
              iban: debtorIban,
              ...(request.body?.debtorBic ? { bic: request.body.debtorBic } : {}),
            },
            transfers,
            version: version as PainVersion,
          });

          return reply.send({
            filename: sepaFilename(version as PainVersion),
            version,
            transfers: transfers.length,
            controlSum: transfers.reduce((sum, t) => sum + t.amount, 0),
            skipped,
            xml,
            disclaimer: PAYMENT_DISCLAIMER,
          });
        } catch (err) {
          return reply.code(422).send({ error: "unbuildable", message: (err as Error).message });
        }
      });
    },
  );
}
