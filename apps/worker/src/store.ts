import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { IngestOutcome } from "@belegbox/ingest";

export interface PutObjectInput {
  sha256: string;
  filename: string;
  bytes: Buffer;
}

export interface PutObjectResult {
  objectKey: string;
  /** True when the exact bytes were already stored - a byte-identical resend. */
  alreadyExisted: boolean;
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
 * F1 week 2 replaces the implementation below with S3 Object Lock plus
 * Postgres. Nothing above this interface changes when it does - which is the
 * point of writing it now rather than faking a database.
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

/**
 * Local stand-in for the WORM archive.
 *
 * Objects are written with the `wx` flag, so a second write of the same digest
 * fails rather than overwriting. That is a deliberately faithful rehearsal of
 * S3 Object Lock semantics: code that assumes it can re-put an object will
 * break here, in development, instead of in production where the bucket is in
 * Compliance mode and nothing can be undone.
 */
export class FilesystemDocumentStore implements DocumentStore {
  private readonly objectsDir: string;
  private readonly recordsFile: string;
  private seen: Set<string> | null = null;

  constructor(private readonly root: string) {
    this.objectsDir = join(root, "objects");
    this.recordsFile = join(root, "records.jsonl");
  }

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    const objectKey = join(input.sha256.slice(0, 2), input.sha256);
    const path = join(this.objectsDir, objectKey);
    await mkdir(dirname(path), { recursive: true });

    try {
      await writeFile(path, input.bytes, { flag: "wx" });
      return { objectKey, alreadyExisted: false };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        return { objectKey, alreadyExisted: true };
      }
      throw err;
    }
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
