import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { IngestOutcome } from "@belegbox/ingest";
import {
  objectKeyFor,
  retainUntilFor,
  type ObjectStore,
  type RetentionMode,
} from "@belegbox/storage";

export interface PutObjectInput {
  sha256: string;
  filename: string;
  bytes: Buffer;
  contentType?: string;
}

export interface PutObjectResult {
  objectKey: string;
  /** True when the exact bytes were already stored - a byte-identical resend. */
  alreadyExisted: boolean;
  retainUntil?: Date;
}

export interface DocumentRecord {
  id: string;
  inboxSlug?: string;
  provider: string;
  providerMessageId: string;
  messageId?: string;
  receivedAt: string;
  from: string;
  subject: string;
  senderAuth: unknown;
  filename: string;
  contentType: string;
  sha256: string;
  sizeBytes: number;
  objectKey: string;
  format?: string;
  profileUrn?: string;
  legalClass?: string;
  invoiceNumber?: string;
  issuedAt?: string;
  docTypeCode?: string;
  status: "pending" | "not_einvoice";
  warnings: string[];
}

export interface IngestedRecord {
  id: string;
  filename: string;
  sha256: string;
  format: string | null;
  status: string;
}

export interface IngestResult {
  /** False when this message was already handled, or could not be routed. */
  accepted: boolean;
  documents: IngestedRecord[];
}

/**
 * The seam between ingest and persistence.
 *
 * One method, because deduplication and writing have to happen together. The
 * earlier shape - ask whether a message was seen, then process, then record -
 * has a gap between the question and the answer that two concurrent
 * redeliveries walk straight through.
 */
export interface DocumentStore {
  ingest(outcome: IngestOutcome): Promise<IngestResult>;
}

export interface DocumentStoreOptions {
  /** Where raw bytes go. S3 with Object Lock in production. */
  objects: ObjectStore;
  /**
   * GOVERNANCE outside production, COMPLIANCE in it. COMPLIANCE cannot be
   * lifted by anyone, including the account root, which is the property GoBD
   * needs and also the one that makes a mistake expensive for a decade.
   */
  retentionMode?: RetentionMode;
  /** § 14b UStG: ten years for invoices, eight for accounting vouchers. */
  retentionYears?: number;
}

/**
 * Document metadata on the local filesystem, raw bytes in the object store.
 *
 * The metadata half is still a JSONL file - Postgres takes over when the worker
 * is wired to it. The bytes half is real: it writes to whatever ObjectStore it
 * is handed, which in production is a Compliance-mode bucket.
 */
export class FilesystemDocumentStore implements DocumentStore {
  private readonly recordsFile: string;
  private readonly objects: ObjectStore;
  private readonly retentionMode: RetentionMode;
  private readonly retentionYears: number;
  private seen: Set<string> | null = null;

  constructor(
    private readonly root: string,
    options: DocumentStoreOptions,
  ) {
    this.recordsFile = join(root, "records.jsonl");
    this.objects = options.objects;
    this.retentionMode = options.retentionMode ?? "GOVERNANCE";
    this.retentionYears = options.retentionYears ?? 10;
  }

  async ingest(outcome: IngestOutcome): Promise<IngestResult> {
    const message = outcome.message;
    const key = `${message.provider}:${message.providerMessageId}`;
    const seen = await this.loadSeen();
    if (message.providerMessageId && seen.has(key)) {
      return { accepted: false, documents: [] };
    }

    const records: DocumentRecord[] = [];
    for (const doc of outcome.documents) {
      const put = await this.putObject({
        sha256: doc.sha256,
        filename: doc.filename,
        bytes: doc.bytes,
        contentType: doc.contentType,
      });

      records.push({
        id: randomUUID(),
        ...(outcome.inboxSlug ? { inboxSlug: outcome.inboxSlug } : {}),
        provider: message.provider,
        providerMessageId: message.providerMessageId,
        ...(message.messageId ? { messageId: message.messageId } : {}),
        receivedAt: message.receivedAt.toISOString(),
        from: message.from,
        subject: message.subject,
        senderAuth: message.senderAuth,
        filename: doc.filename,
        contentType: doc.contentType,
        sha256: doc.sha256,
        sizeBytes: doc.sizeBytes,
        objectKey: put.objectKey,
        ...(doc.detection
          ? {
              format: doc.detection.format,
              profileUrn: doc.detection.profile.urn,
              legalClass: doc.detection.profile.legalClass,
              ...(doc.detection.invoiceNumber
                ? { invoiceNumber: doc.detection.invoiceNumber }
                : {}),
              ...(doc.detection.issueDate ? { issuedAt: doc.detection.issueDate } : {}),
              ...(doc.detection.documentTypeCode
                ? { docTypeCode: doc.detection.documentTypeCode }
                : {}),
            }
          : {}),
        // This store does not validate; the Postgres one does. Ingest on its own
        // can only conclude that a document is not an e-invoice at all.
        status:
          doc.detection && doc.detection.profile.legalClass === "einvoice"
            ? "pending"
            : "not_einvoice",
        warnings: outcome.warnings.map((w) => w.code),
      });
    }

    await mkdir(this.root, { recursive: true });
    const lines = records.map((r) => `${JSON.stringify(r)}\n`).join("");
    // A message with no documents is still recorded, so a supplier sending
    // nothing but PDFs is visible rather than invisible.
    await appendFile(
      this.recordsFile,
      lines ||
        `${JSON.stringify({
          messageOnly: true,
          provider: message.provider,
          providerMessageId: message.providerMessageId,
          receivedAt: message.receivedAt.toISOString(),
          warnings: outcome.warnings.map((w) => w.code),
        })}\n`,
      "utf8",
    );
    if (message.providerMessageId) seen.add(key);

    return {
      accepted: true,
      documents: records.map((r) => ({
        id: r.id,
        filename: r.filename,
        sha256: r.sha256,
        format: r.format ?? null,
        status: r.status,
      })),
    };
  }

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    // Retention is applied at write time, not when the document is later
    // archived. A document that arrives and is never processed is still one the
    // tenant is required to keep.
    const retention = {
      mode: this.retentionMode,
      retainUntil: retainUntilFor(new Date(), this.retentionYears),
    };

    const result = await this.objects.put({
      key: objectKeyFor(input.sha256),
      bytes: input.bytes,
      sha256: input.sha256,
      ...(input.contentType ? { contentType: input.contentType } : {}),
      retention,
    });

    return {
      objectKey: result.key,
      alreadyExisted: result.alreadyExisted,
      ...(result.retainUntil ? { retainUntil: result.retainUntil } : {}),
    };
  }

  private async loadSeen(): Promise<Set<string>> {
    if (this.seen) return this.seen;
    const seen = new Set<string>();
    try {
      const raw = await readFile(this.recordsFile, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as {
            provider?: string;
            providerMessageId?: string;
          };
          if (parsed.provider && parsed.providerMessageId) {
            seen.add(`${parsed.provider}:${parsed.providerMessageId}`);
          }
        } catch {
          // A corrupt line must not make the worker refuse every future message.
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    this.seen = seen;
    return seen;
  }
}
