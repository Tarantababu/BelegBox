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

/**
 * The seam between ingest and persistence.
 *
 * Raw bytes now go to a real object store; the metadata side is still a JSONL
 * file until the worker is wired to Postgres. Nothing above this interface
 * changed when the storage half was swapped, which is what the seam was for.
 */
export interface DocumentStore {
  /** Writes raw bytes once. Re-writing the same digest must not overwrite. */
  putObject(input: PutObjectInput): Promise<PutObjectResult>;
  /** Records document metadata. Returns false when this message was already handled. */
  recordMessage(
    outcome: IngestOutcome,
    records: DocumentRecord[],
  ): Promise<{ accepted: boolean }>;
  /** Idempotency for webhook redelivery, which every provider does. */
  hasSeenMessage(provider: string, providerMessageId: string): Promise<boolean>;
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

  async hasSeenMessage(provider: string, providerMessageId: string): Promise<boolean> {
    if (!providerMessageId) return false;
    const seen = await this.loadSeen();
    return seen.has(`${provider}:${providerMessageId}`);
  }

  async recordMessage(
    outcome: IngestOutcome,
    records: DocumentRecord[],
  ): Promise<{ accepted: boolean }> {
    const key = `${outcome.message.provider}:${outcome.message.providerMessageId}`;
    const seen = await this.loadSeen();
    if (outcome.message.providerMessageId && seen.has(key)) {
      return { accepted: false };
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
          provider: outcome.message.provider,
          providerMessageId: outcome.message.providerMessageId,
          receivedAt: outcome.message.receivedAt.toISOString(),
          warnings: outcome.warnings.map((w) => w.code),
        })}\n`,
      "utf8",
    );

    if (outcome.message.providerMessageId) seen.add(key);
    return { accepted: true };
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
