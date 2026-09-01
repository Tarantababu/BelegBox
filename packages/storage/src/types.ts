/**
 * Retention mode.
 *
 * GOVERNANCE can be lifted by a principal holding
 * `s3:BypassGovernanceRetention`. COMPLIANCE cannot be lifted by anyone,
 * including the account root, until the retain-until date passes - which is the
 * property GoBD Unveränderbarkeit actually needs, and also the property that
 * makes a mistake expensive for ten years.
 *
 * Development and staging use GOVERNANCE. Production uses COMPLIANCE.
 */
export type RetentionMode = "GOVERNANCE" | "COMPLIANCE";

export interface Retention {
  mode: RetentionMode;
  retainUntil: Date;
}

export interface PutObjectInput {
  /** Content-addressed: derived from the digest, never from a filename. */
  key: string;
  bytes: Buffer;
  /** Hex SHA-256 of `bytes`. Sent to the store so the server verifies it too. */
  sha256: string;
  contentType?: string;
  retention?: Retention;
}

export interface PutObjectResult {
  key: string;
  /**
   * True when the exact key was already present and nothing was written. The
   * archive is content-addressed, so a second put of the same digest is a
   * duplicate delivery, not an update.
   */
  alreadyExisted: boolean;
  versionId?: string;
  retainUntil?: Date;
}

export interface ObjectInfo {
  key: string;
  sizeBytes: number;
  versionId?: string;
  retainUntil?: Date;
  retentionMode?: RetentionMode;
}

/**
 * The archive's write interface.
 *
 * There is deliberately no `delete`. The archive keeps invoices for ten years
 * under § 14b UStG, and a method that removes one has no legitimate caller in
 * this system - so the interface cannot express it, and no amount of pressure
 * during an incident can produce a tempting one-liner. Expiry after the
 * retention period is an operational procedure, not an application feature.
 */
export interface ObjectStore {
  put(input: PutObjectInput): Promise<PutObjectResult>;
  get(key: string): Promise<Buffer>;
  head(key: string): Promise<ObjectInfo | undefined>;
}

export class ObjectStoreError extends Error {
  constructor(
    message: string,
    readonly key: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ObjectStoreError";
  }
}

/** Content-addressed key: two hex characters of prefix, then the digest. */
export function objectKeyFor(sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`Not a SHA-256 digest: ${sha256}`);
  }
  return `${sha256.slice(0, 2)}/${sha256}`;
}

/**
 * Retention deadline for a document.
 *
 * § 14b UStG requires ten years for invoices; BEG IV reduced accounting
 * vouchers to eight. The period runs from the end of the calendar year in which
 * the document was issued, not from the day it arrived, so the date is computed
 * from 31 December of that year.
 */
export function retainUntilFor(archivedAt: Date, years: number): Date {
  const endOfYear = Date.UTC(archivedAt.getUTCFullYear(), 11, 31, 23, 59, 59, 0);
  const deadline = new Date(endOfYear);
  deadline.setUTCFullYear(deadline.getUTCFullYear() + years);
  return deadline;
}
