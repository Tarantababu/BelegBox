import { parseInvoice } from "@belegbox/core-invoice";
import {
  claimInboundMessage,
  finishInboundMessage,
  insertDocument,
  insertFindings,
  resolveInbox,
  type Db,
} from "@belegbox/db";
import type { IngestOutcome, IngestedDocument } from "@belegbox/ingest";
import type { RuleSet } from "@belegbox/rules-engine";
import {
  objectKeyFor,
  retainUntilFor,
  type ObjectStore,
  type RetentionMode,
} from "@belegbox/storage";
import { MustangClient, validateDocument } from "@belegbox/validation";
import type {
  DocumentStore,
  IngestResult,
  IngestedRecord,
  PutObjectInput,
  PutObjectResult,
} from "./store.js";

export interface PostgresStoreOptions {
  db: Db;
  objects: ObjectStore;
  retentionMode?: RetentionMode;
  retentionYears?: number;
  /** Absent means the form verdict stays unknown rather than being guessed. */
  mustang?: MustangClient;
  /** Per-tenant rulesets would come from the database; one default for now. */
  ruleSet?: RuleSet;
}

/**
 * The real receiving path: bytes to the WORM archive, metadata and verdicts to
 * PostgreSQL.
 *
 * Validation runs here rather than in a later pass, so a document is never
 * visible without a verdict. A row that says nothing about a document is worse
 * than no row: the inbox shows it as unremarkable, and the whole point is that
 * some of them are not.
 */
export class PostgresDocumentStore implements DocumentStore {
  private readonly retentionMode: RetentionMode;
  private readonly retentionYears: number;

  constructor(private readonly options: PostgresStoreOptions) {
    this.retentionMode = options.retentionMode ?? "GOVERNANCE";
    this.retentionYears = options.retentionYears ?? 10;
  }

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    const result = await this.options.objects.put({
      key: objectKeyFor(input.sha256),
      bytes: input.bytes,
      sha256: input.sha256,
      ...(input.contentType ? { contentType: input.contentType } : {}),
      retention: {
        mode: this.retentionMode,
        retainUntil: retainUntilFor(new Date(), this.retentionYears),
      },
    });

    return {
      objectKey: result.key,
      alreadyExisted: result.alreadyExisted,
      ...(result.retainUntil ? { retainUntil: result.retainUntil } : {}),
    };
  }

  /**
   * Writes one inbound message: claim, archive, validate, record.
   *
   * Everything after the claim runs in one transaction, so a failure anywhere
   * releases the claim and the provider's next redelivery gets a clean attempt.
   * The object store is the exception - it is written before the transaction and
   * cannot be rolled back, which is deliberate: an orphaned object under
   * retention costs storage, while a lost invoice costs a customer.
   */
  async ingest(outcome: IngestOutcome): Promise<IngestResult> {
    const message = outcome.message;

    const resolved = await this.options.db.withAdmin((client) =>
      resolveInbox(client, message.to),
    );

    if (!resolved) {
      // Misdirected mail and probes are recorded with no tenant, which the RLS
      // policy renders invisible to everyone. Silently discarding them would
      // hide the busiest part of the attack surface.
      await this.options.db.withAdmin(async (client) => {
        await client.query("BEGIN");
        await claimInboundMessage(client, {
          provider: message.provider,
          providerMessageId: message.providerMessageId,
          tenantId: null,
          recipient: message.to,
          messageId: message.messageId ?? null,
        });
        await client.query("COMMIT");
      });
      return { accepted: false, documents: [] };
    }

    // Archive first. An object written for a message that then fails is an
    // orphan; a message accepted whose bytes were never stored is a lost
    // invoice.
    const stored = new Map<string, PutObjectResult>();
    for (const doc of outcome.documents) {
      stored.set(
        doc.sha256,
        await this.putObject({
          sha256: doc.sha256,
          filename: doc.filename,
          bytes: doc.bytes,
          contentType: doc.contentType,
        }),
      );
    }

    const validated = await Promise.all(
      outcome.documents.map((doc) => this.validate(doc)),
    );

    return this.options.db.withTenant(resolved.tenantId, async (tx) => {
      const claimId = await claimInboundMessage(tx, {
        provider: message.provider,
        providerMessageId: message.providerMessageId,
        tenantId: resolved.tenantId,
        recipient: message.to,
        messageId: message.messageId ?? null,
      });
      if (!claimId) {
        return { accepted: false, documents: [] };
      }

      const written: IngestedRecord[] = [];

      for (const [index, doc] of outcome.documents.entries()) {
        const result = validated[index];
        const object = stored.get(doc.sha256);
        const invoice = result?.invoice;

        const { id, duplicate } = await insertDocument(tx, {
          inboxId: resolved.inboxId,
          sourceChannel: "email",
          rawObjectKey: object?.objectKey ?? objectKeyFor(doc.sha256),
          rawSha256: doc.sha256,
          sizeBytes: doc.sizeBytes,
          filename: doc.filename,
          contentType: doc.contentType,
          format: doc.detection?.format ?? null,
          profileUrn: doc.detection?.profile.urn ?? null,
          status: result?.status ?? "not_einvoice",
          verdictForm: result?.verdictForm ?? "n_a",
          verdictContent: result?.verdictContent ?? "n_a",
          docTypeCode: doc.detection?.documentTypeCode ?? null,
          senderAuth: message.senderAuth,
          messageId: message.messageId ?? null,
          issuedAt: invoice?.issueDate ?? doc.detection?.issueDate ?? null,
          dueAt: invoice?.dueDate ?? null,
          receivedAt: message.receivedAt.toISOString(),
          supplierName: invoice?.seller.name ?? null,
          supplierVatId: invoice?.seller.vatId ?? null,
          invoiceNumber: invoice?.invoiceNumber ?? doc.detection?.invoiceNumber ?? null,
          totalGross: invoice?.totals.taxInclusive ?? null,
          totalNet: invoice?.totals.taxExclusive ?? null,
          totalVat: invoice?.totals.taxTotal ?? null,
          parsed: invoice ?? null,
        });

        // A duplicate already carries its findings from the first delivery;
        // writing them again would double every one in the detail view.
        if (!duplicate && result) {
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
        }

        written.push({
          id,
          filename: doc.filename,
          sha256: doc.sha256,
          format: doc.detection?.format ?? null,
          status: result?.status ?? "not_einvoice",
        });
      }

      await finishInboundMessage(
        tx,
        claimId,
        written.length,
        outcome.warnings.map((w) => w.code),
      );

      return { accepted: true, documents: written };
    });
  }

  private async validate(doc: IngestedDocument) {
    const payload = doc.payload?.bytes ?? doc.bytes;

    const result = await validateDocument(
      { filename: doc.filename, bytes: payload },
      {
        ...(this.options.mustang ? { client: this.options.mustang } : { skipL1L2: true }),
        ...(this.options.ruleSet ? { ruleSet: this.options.ruleSet } : {}),
        direction: "incoming",
      },
    );

    let invoice;
    try {
      invoice = parseInvoice(payload);
    } catch {
      // A document with no parseable invoice still gets a row; the detection
      // error is already a finding.
      invoice = undefined;
    }

    return {
      status: result.status,
      verdictForm: result.verdict.form,
      verdictContent: result.verdict.content,
      findings: result.findings,
      invoice,
    };
  }
}
