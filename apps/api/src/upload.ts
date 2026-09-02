import { DEFAULT_MAX_ATTACHMENT_BYTES, ingestMessage } from "@belegbox/ingest";
import {
  archiveDocument,
  insertDocument,
  insertFindings,
  type Db,
} from "@belegbox/db";
import type { ObjectStore, RetentionMode } from "@belegbox/storage";
import { retainUntilFor } from "@belegbox/storage";
import { parseInvoice } from "@belegbox/core-invoice";
import { MustangClient, validateDocument } from "@belegbox/validation";
import type { RuleSet } from "@belegbox/rules-engine";
import type { FastifyInstance, FastifyRequest } from "fastify";

export interface UploadRouteDeps {
  db: Db;
  storage: ObjectStore;
  resolveTenant: (request: FastifyRequest) => Promise<string | undefined>;
  ruleSet?: RuleSet | undefined;
  retentionMode?: RetentionMode | undefined;
  retentionYears?: number | undefined;
  maxBytes?: number | undefined;
}

/** Content-addressed, like the worker's. The filename never decides the key. */
function objectKeyFor(sha256: string): string {
  return `${sha256.slice(0, 2)}/${sha256}`;
}

/**
 * Manual upload.
 *
 * Documents normally arrive at the tenant's inbox address, and that remains the
 * path that carries sender authentication. But inbound mail needs a provider
 * and DNS, and until those are in place a freshly deployed instance has no way
 * to receive an invoice at all - so this exists, and so does the drag-and-drop
 * on the inbox screen. It is also the answer for the invoice a supplier handed
 * over on a USB stick.
 *
 * The whole ingest pipeline is reused rather than reimplemented: a synthesised
 * one-attachment message goes through the same extraction, the same PDF/A-3
 * embedded-XML handling and the same size limits as an email would. A second
 * code path for the same job is how two behaviours diverge.
 *
 * `senderAuth` is null and stays null. An uploaded file has no SPF, DKIM or
 * DMARC to record, and inventing a "pass" would put a fabricated authentication
 * result on a document that will be read as evidence for ten years.
 */
/**
 * Detection codes that mean "we know what this is, and it is an invoice" -
 * as opposed to "we could not make sense of this file".
 *
 * Both are refusals to validate against EN 16931, and only the first is a
 * document worth keeping. Keeping them apart is what lets upload reject a
 * delivery note while accepting a ten-year-old ZUGFeRD invoice.
 */
const NAMED_INVOICE_FORMATS = new Set(["zugferd_v1", "foreign_format"]);

function isNamedInvoiceFormat(code: string | undefined): boolean {
  return code !== undefined && NAMED_INVOICE_FORMATS.has(code);
}

export function registerUploadRoutes(app: FastifyInstance, deps: UploadRouteDeps): void {
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;

  // Raw bytes rather than multipart: the browser side unpacks the form and
  // forwards the file, which keeps a multipart parser out of the API's
  // dependency surface.
  //
  // Any content type, because a browser sends whatever the operating system
  // guessed - text/plain for an .xml on some machines. Restricting the list
  // meant Fastify refused the body before the handler ran, and the user got a
  // media-type error instead of being told what the file actually needed to
  // be. What the file is gets decided by looking at it, below.
  app.addContentTypeParser(
    "*",
    { parseAs: "buffer", bodyLimit: maxBytes },
    (_request, body, done) => done(null, body),
  );

  // text/plain needs saying explicitly: Fastify ships a built-in parser for it
  // that wins over the wildcard and hands the handler a string, so an .xml the
  // browser labelled text/plain arrived as text and was reported as an empty
  // body. application/json is deliberately left alone - every other route
  // needs the default parser.
  app.addContentTypeParser(
    "text/plain",
    { parseAs: "buffer", bodyLimit: maxBytes },
    (_request, body, done) => done(null, body),
  );

  app.post("/v1/documents/upload", async (request, reply) => {
    const tenantId = await deps.resolveTenant(request);
    if (!tenantId) return reply.code(401).send({ error: "unauthorized" });

    // A string can still reach here if some other parser claimed the type
    // first; the bytes are the same either way.
    const raw = request.body;
    const bytes = Buffer.isBuffer(raw)
      ? raw
      : typeof raw === "string"
        ? Buffer.from(raw, "utf8")
        : undefined;

    if (!bytes || bytes.length === 0) {
      return reply.code(400).send({
        error: "empty_body",
        message: "Es wurde keine Datei übertragen.",
      });
    }
    if (bytes.length > maxBytes) {
      return reply.code(413).send({
        error: "too_large",
        message: `Die Datei ist größer als ${Math.floor(maxBytes / 1024 / 1024)} MB.`,
      });
    }

    // The filename is display metadata and nothing more: it never becomes an
    // object key, a ZIP entry name or a path.
    const headerName = request.headers["x-belegbox-filename"];
    const filename = (typeof headerName === "string" ? decodeURIComponent(headerName) : "upload")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .slice(0, 200) || "upload";

    const receivedAt = new Date();

    const outcome = await ingestMessage(
      {
        provider: "upload",
        providerMessageId: `upload-${receivedAt.getTime()}`,
        // The tenant is already resolved from the session, so nothing
        // downstream needs the inbox address - looking it up cost a round trip
        // before the file had even been looked at.
        to: "upload",
        from: "upload",
        subject: filename,
        receivedAt,
        // "none", not "pass". There is no email envelope to authenticate, and
        // recording a pass would fabricate an authentication result on a
        // document that is read as evidence for ten years.
        senderAuth: { spf: "none", dkim: "none", dmarc: "none" },
        attachments: [
          {
            filename,
            contentType: String(request.headers["content-type"] ?? "application/octet-stream"),
            bytes,
          },
        ],
      },
      { maxAttachmentBytes: maxBytes },
    );

    // Nothing recognisable in the file. Refused rather than archived, and this
    // is where upload deliberately differs from email: a document that arrived
    // by email is kept whatever it turns out to be, because it arrived and
    // § 14b applies to it. An upload is someone choosing a file, and choosing
    // the wrong one should not put it beyond reach for ten years - Object Lock
    // in COMPLIANCE mode cannot be undone by anyone, including us.
    //
    // The test is whether the file was recognised as an invoice, not whether it
    // is legally an e-invoice. A ZUGFeRD MINIMUM is detected and must still be
    // accepted, since telling the user it is not a valid e-invoice (D-001) is
    // the point - and by the same reasoning so must a format we identified by
    // name and then declined to validate. ZUGFeRD 1.0 and fatturaPA are real
    // invoices; "this is ZUGFeRD 1.0, which predates EN 16931" is exactly the
    // answer the uploader came for, and refusing the file withholds it.
    //
    // Everything else still bounces: XML that is not an invoice, a PDF with no
    // attachment, a root element we cannot name. Those are the wrong-file case
    // the refusal exists for.
    const recognised = outcome.documents.filter(
      (doc) => doc.detection ?? isNamedInvoiceFormat(doc.detectionError?.code),
    );

    if (recognised.length === 0) {
      return reply.code(422).send({
        error: "no_invoice",
        message:
          "In dieser Datei wurde keine Rechnung gefunden. Erwartet werden XRechnung (XML) oder ZUGFeRD/Factur-X (PDF).",
        warnings: outcome.warnings,
      });
    }

    const mustang = new MustangClient();
    const written: Array<{ id: string; duplicate: boolean; status: string; filename: string }> = [];

    for (const doc of recognised) {
      // Archived before it is recorded. A row pointing at bytes that were never
      // stored is a lost invoice; an object with no row is only an orphan.
      const object = await deps.storage.put({
        key: objectKeyFor(doc.sha256),
        bytes: doc.bytes,
        sha256: doc.sha256,
        ...(doc.contentType ? { contentType: doc.contentType } : {}),
        ...(deps.retentionMode
          ? {
              retention: {
                mode: deps.retentionMode,
                retainUntil: retainUntilFor(receivedAt, deps.retentionYears ?? 10),
              },
            }
          : {}),
      });

      // The invoice XML, not the container it arrived in. `doc.bytes` is what
      // gets archived - the original PDF, byte for byte - while `doc.payload`
      // is the XML that ingest pulled out of it. Validating the container meant
      // detection saw `%PDF-` and answered "extract the embedded XML first", so
      // every ZUGFeRD PDF uploaded through the web button came back
      // `not_einvoice` with an internal note, however good the invoice inside
      // was. The worker has always used the payload; only this path did not.
      const payload = doc.payload?.bytes ?? doc.bytes;

      const result = await validateDocument(
        { filename: doc.filename, bytes: payload },
        { client: mustang, ...(deps.ruleSet ? { ruleSet: deps.ruleSet } : {}) },
      );

      let invoice;
      try {
        invoice = parseInvoice(payload);
      } catch {
        // Not parseable is a verdict the pipeline already recorded; the row
        // still gets written, without the summary columns.
        invoice = undefined;
      }

      const record = await deps.db.withTenant(tenantId, async (tx) => {
        const { id, duplicate } = await insertDocument(tx, {
          sourceChannel: "upload",
          rawObjectKey: object.key,
          rawSha256: doc.sha256,
          sizeBytes: doc.sizeBytes,
          filename: doc.filename,
          contentType: doc.contentType ?? null,
          format: doc.detection?.format ?? null,
          profileUrn: doc.detection?.profile.urn ?? null,
          status: result.status,
          verdictForm: result.verdict.form,
          verdictContent: result.verdict.content,
          docTypeCode: doc.detection?.documentTypeCode ?? null,
          // No email, so nothing to record. Not a "pass".
          // "none", not "pass". There is no email envelope to authenticate, and
        // recording a pass would fabricate an authentication result on a
        // document that is read as evidence for ten years.
        senderAuth: { spf: "none", dkim: "none", dmarc: "none" },
          issuedAt: invoice?.issueDate ?? doc.detection?.issueDate ?? null,
          dueAt: invoice?.dueDate ?? null,
          receivedAt: receivedAt.toISOString(),
          supplierName: invoice?.seller.name ?? null,
          supplierVatId: invoice?.seller.vatId ?? null,
          invoiceNumber: invoice?.invoiceNumber ?? doc.detection?.invoiceNumber ?? null,
          totalGross: invoice?.totals.taxInclusive ?? null,
          totalNet: invoice?.totals.taxExclusive ?? null,
          totalVat: invoice?.totals.taxTotal ?? null,
          parsed: invoice ?? null,
        });

        if (!duplicate) {
          await insertFindings(
            tx,
            result.findings.map((f) => ({
              documentId: id,
              layer: f.layer,
              code: f.code,
              severity: f.severity,
              btRef: f.btRef ?? null,
              legalBasis: f.legalBasis ?? null,
              messageRaw: f.messageRaw,
              explainKey: f.explainKey ?? null,
              params: f.params ?? null,
              validatorConfigVersion: f.versions.validatorConfigVersion,
              engineVersion: f.versions.engineVersion,
              rulesetVersion: f.versions.rulesetVersion ?? null,
            })),
          );
          await archiveDocument(tx, id, { archivedAt: receivedAt });
        }

        return { id, duplicate, status: result.status, filename: doc.filename };
      });

      written.push(record);
    }

    return reply.code(201).send({
      documents: written,
      warnings: outcome.warnings,
    });
  });
}
