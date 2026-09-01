/**
 * M-06, second half. The originals that belong with the Buchungsstapel.
 *
 * A booking without its Beleg is not a booking anyone can defend. GoBD asks
 * that the record and the document behind it stay connected, so the export that
 * hands over the postings has to hand over the invoices too - and has to make
 * the link between them findable by a person, not only by a database.
 *
 * Two properties decide whether this is worth anything:
 *
 *   1. The bytes are the archived originals, unchanged. Not re-serialised, not
 *      re-encoded, not regenerated from the parsed model. What the supplier
 *      sent is what the Steuerberater receives.
 *   2. Nothing goes missing quietly. A document that could not be included is
 *      named in the manifest with the reason, because a bundle that is short by
 *      one invoice and does not say so is worse than one that fails outright.
 */

export type DocumentFormat =
  | "xrechnung_ubl"
  | "xrechnung_cii"
  | "zugferd"
  | "peppol_bis"
  | "other";

/** One document as the export sees it. */
export interface BelegSource {
  id: string;
  rawObjectKey: string;
  /** The digest recorded when the document was archived. */
  rawSha256: string;
  sizeBytes: number;
  supplierName: string | null;
  invoiceNumber: string | null;
  issuedAt: string | null;
  totalGross: string | null;
  status: string;
  format: string | null;
  contentType: string | null;
  receivedAt: Date;
  /** The archive day this document was sealed into, when it has been. */
  archiveDay: string | null;
  /** That day's Merkle root, so the recipient can check inclusion later. */
  merkleRoot: string | null;
}

/**
 * Why a document is in the period but not in the bundle.
 *
 * `hash_mismatch` is the one that matters. It means the bytes in storage are
 * not the bytes that were archived - either corruption or tampering - and the
 * export refuses to pass them off as an original. It is a finding about the
 * archive, not a formatting problem, and it is surfaced as one.
 */
export type SkipReason = "not_in_storage" | "hash_mismatch" | "read_failed";

export interface SkippedBeleg {
  documentId: string;
  invoiceNumber: string | null;
  supplierName: string | null;
  reason: SkipReason;
  /** For a hash mismatch: what was archived, and what came back. */
  expectedSha256?: string;
  actualSha256?: string;
}

export interface IncludedBeleg {
  documentId: string;
  entryName: string;
  sha256: string;
  sizeBytes: number;
}

export interface BundleResult {
  filename: string;
  bytes: Buffer;
  included: IncludedBeleg[];
  skipped: SkippedBeleg[];
  /** SHA-256 over the bundle itself, so the hand-over can be acknowledged. */
  sha256: string;
}

export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleError";
  }
}
