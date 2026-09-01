import { generateTotpSecret, hashPassword, requiresMfa, totpUri } from "@belegbox/auth";
import { createUser } from "@belegbox/db";
import { renderBoth, type Locale, type Registry } from "@belegbox/explain";
import { generateInboxAddress } from "@belegbox/ingest";
import {
  countByStatus,
  createTenant,
  getDocument,
  getFindings,
  getInboxAddress,
  getTenant,
  listDocuments,
  type Db,
} from "@belegbox/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const STATUSES = new Set(["clean", "form_error", "content_error", "not_einvoice", "pending"]);

export interface RouteDeps {
  db: Db;
  explain: Registry;
  resolveTenant: (request: FastifyRequest) => Promise<string | undefined>;
  /** Templates are unapproved until the lawyer signs off (Ek A). */
  allowUnapprovedTemplates?: boolean;
  inboxDomain?: string;
}

/**
 * The supplier notification (M-01).
 *
 * Suppliers may already send e-invoices without asking - the obligation to
 * receive has been in force since 1 January 2025. This text exists so the user
 * does not have to compose German correspondence to claim their own address.
 */
function supplierNotice(companyName: string, address: string): string {
  return [
    "Sehr geehrte Damen und Herren,",
    "",
    `wir empfangen E-Rechnungen ab sofort unter folgender Adresse:`,
    "",
    `    ${address}`,
    "",
    "Bitte senden Sie künftige Rechnungen als XRechnung (UBL oder CII) oder als",
    "ZUGFeRD/Factur-X ab Profil EN 16931 an diese Adresse. Die ZUGFeRD-Profile",
    "MINIMUM und BASIC WL enthalten keine Daten auf Positionsebene und gelten",
    "nicht als E-Rechnung.",
    "",
    "Mit freundlichen Grüßen",
    companyName,
  ].join("\n");
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const renderOptions = { allowUnapproved: deps.allowUnapprovedTemplates ?? false };

  async function requireTenant(
    request: FastifyRequest,
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ): Promise<string | undefined> {
    const tenantId = await deps.resolveTenant(request);
    if (!tenantId) {
      reply.code(401).send({ error: "unauthorized" });
      return undefined;
    }
    return tenantId;
  }

  /** M-01. Three fields, no card, an address at the end of it. */
  app.post<{
    Body: {
      name?: string;
      taxId?: string;
      industry?: string;
      locale?: string;
      email?: string;
      password?: string;
    };
  }>("/v1/tenants", async (request, reply) => {
    const name = request.body?.name?.trim();
    if (!name) {
      return reply.code(400).send({ error: "name is required" });
    }

    const email = request.body?.email?.trim();
    const password = request.body?.password ?? "";
    if (!email || !email.includes("@")) {
      return reply.code(400).send({ error: "a valid email is required" });
    }

    let passwordHash: string;
    try {
      passwordHash = await hashPassword(password);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    if (name.length > 200) {
      return reply.code(400).send({ error: "name is too long" });
    }

    const industry = request.body?.industry?.trim() || null;
    const locale = request.body?.locale === "tr" ? "tr" : "de";
    const taxId = request.body?.taxId?.trim() || null;

    // A VAT identifier and a Steuernummer are different things and only one
    // field is asked for, so the shape decides which column it lands in.
    const isVatId = taxId ? /^[A-Z]{2}[0-9A-Z]{2,12}$/i.test(taxId.replace(/\s+/g, "")) : false;

    const address = generateInboxAddress(name, deps.inboxDomain ?? "belegbox.de");

    try {
      const created = await deps.db.withAdmin((client) =>
        createTenant(client, {
          name,
          slug: address.slug,
          inboxAddress: address.address,
          inboxSuffix: address.suffix,
          vatId: isVatId ? taxId : null,
          taxNumber: isVatId ? null : taxId,
          industry,
          locale,
        }),
      );

      // The owner role requires MFA (PRD § 10.3), so the secret is issued here
      // and confirmed on the first sign-in. Issuing it later would mean handing
      // someone an account they cannot use.
      const secret = generateTotpSecret();

      await deps.db.withTenant(created.tenant.id, (tx) =>
        createUser(tx, {
          email,
          role: "owner",
          passwordHash,
          locale,
          totpSecret: secret,
          // Not enabled until a code proves the authenticator was set up.
          mfaEnabled: false,
        }),
      );

      return reply.code(201).send({
        tenantId: created.tenant.id,
        name: created.tenant.name,
        locale: created.tenant.locale,
        industry: created.tenant.industry,
        inboxAddress: created.inboxAddress,
        supplierNotice: supplierNotice(name, created.inboxAddress),
        // Returned once, never stored anywhere the user can read it back.
        mfa: {
          required: requiresMfa("owner"),
          secret,
          uri: totpUri(secret, email),
        },
      });
    } catch (err) {
      // The random suffix makes a slug collision improbable rather than
      // impossible; retrying is the caller's business, not a 500.
      if ((err as { code?: string }).code === "23505") {
        return reply
          .code(409)
          .send({ error: "that email or address is already registered" });
      }
      throw err;
    }
  });

  app.get("/v1/tenant", async (request, reply) => {
    const tenantId = await requireTenant(request, reply);
    if (!tenantId) return reply;

    return deps.db.withTenant(tenantId, async (tx) => {
      const tenant = await getTenant(tx);
      if (!tenant) return reply.code(404).send({ error: "not found" });
      return reply.send({
        id: tenant.id,
        name: tenant.name,
        locale: tenant.locale,
        industry: tenant.industry,
        inboxAddress: (await getInboxAddress(tx)) ?? null,
      });
    });
  });

  /** M-02. The list, and the three counts above it. */
  app.get<{ Querystring: { status?: string; q?: string } }>(
    "/v1/documents",
    async (request, reply) => {
      const tenantId = await requireTenant(request, reply);
      if (!tenantId) return reply;

      const status = request.query.status;
      if (status && !STATUSES.has(status)) {
        return reply.code(400).send({ error: `unknown status "${status}"` });
      }

      return deps.db.withTenant(tenantId, async (tx) => {
        const [documents, counts] = await Promise.all([
          listDocuments(tx, {
            ...(status ? { status } : {}),
            ...(request.query.q ? { search: request.query.q } : {}),
          }),
          countByStatus(tx),
        ]);

        return reply.send({
          documents: documents.map((d) => ({
            id: d.id,
            supplier: d.supplier_name,
            invoiceNumber: d.invoice_number,
            issuedAt: d.issued_at,
            dueAt: d.due_at,
            totalGross: d.total_gross === null ? null : Number(d.total_gross),
            format: d.format,
            status: d.status,
            verdict: { form: d.verdict_form, content: d.verdict_content },
            findingCount: Number(d.finding_count),
            receivedAt: d.received_at.toISOString(),
          })),
          counts: Object.fromEntries(counts.map((c) => [c.status, c.count])),
        });
      });
    },
  );

  /**
   * M-03. The dual verdict, the raw validator output, and the explanation.
   *
   * The explanation is rendered here rather than in the web app, so an API
   * customer building their own interface gets the same reviewed wording -
   * including the disclaimer they cannot switch off.
   */
  app.get<{ Params: { id: string }; Querystring: { locale?: string } }>(
    "/v1/documents/:id",
    async (request, reply) => {
      const tenantId = await requireTenant(request, reply);
      if (!tenantId) return reply;

      const { id } = request.params;
      if (!UUID.test(id)) return reply.code(400).send({ error: "document id must be a UUID" });

      return deps.db.withTenant(tenantId, async (tx) => {
        const document = await getDocument(tx, id);
        // Not yours and does not exist answer identically, or the response
        // leaks the existence of another tenant's document.
        if (!document) return reply.code(404).send({ error: "not found" });

        const tenant = await getTenant(tx);
        const locale: Locale =
          request.query.locale === "tr" || request.query.locale === "de"
            ? request.query.locale
            : ((tenant?.locale === "tr" ? "tr" : "de") as Locale);

        const findings = await getFindings(tx, id);

        return reply.send({
          id: document.id,
          status: document.status,
          verdict: { form: document.verdict_form, content: document.verdict_content },
          format: document.format,
          profileUrn: document.profile_urn,
          receivedAt: document.received_at.toISOString(),
          archivedAt: document.archived_at?.toISOString() ?? null,
          findings: findings.map((f) => {
            const params = f.params ?? {};
            const explained = f.explain_key
              ? renderBoth(deps.explain, f.explain_key, locale, params, {
                  ...renderOptions,
                  rawMessage: f.message_raw,
                })
              : undefined;

            return {
              id: f.id,
              layer: f.layer,
              code: f.code,
              severity: f.severity,
              btRef: f.bt_ref,
              legalBasis: f.legal_basis,
              // Shown next to the explanation, never instead of it. The
              // transparency is a differentiator, not a debug affordance.
              messageRaw: f.message_raw,
              params,
              explanation: explained
                ? {
                    locale,
                    observation: explained.primary.observation,
                    legalBasis: explained.primary.legalBasis,
                    nextStep: explained.primary.nextStep ?? null,
                    disclaimer: explained.primary.disclaimer,
                    fallback: explained.primary.fallback,
                    approved: explained.primary.approved,
                    // The German text is what gets forwarded to a supplier or a
                    // Steuerberater, so it travels with every finding.
                    german: {
                      observation: explained.german.observation,
                      legalBasis: explained.german.legalBasis,
                      nextStep: explained.german.nextStep ?? null,
                      disclaimer: explained.german.disclaimer,
                    },
                  }
                : null,
              versions: {
                validatorConfig: f.validator_config_version,
                engine: f.engine_version,
                ruleset: f.ruleset_version,
              },
            };
          }),
        });
      });
    },
  );
}
