import type { DetectionResult } from "@belegbox/core-invoice";

/** SPF / DKIM / DMARC as reported by the receiving MTA. */
export type AuthVerdict = "pass" | "fail" | "softfail" | "neutral" | "none" | "unknown";

/**
 * PRD § 10.3: the inbound mailbox is this product's most realistic attack
 * surface. A forged invoice with a swapped IBAN is the loss event that kills a
 * customer, so the authentication result is stored on the document and feeds
 * D-008 rather than being discarded at the door.
 */
export interface SenderAuth {
  spf: AuthVerdict;
  dkim: AuthVerdict;
  dmarc: AuthVerdict;
  /** DKIM signing domain (`header.d`), when the MTA reported one. */
  dkimDomain?: string;
  /** The Authentication-Results header, verbatim. */
  raw?: string;
}

export interface RawAttachment {
  filename: string;
  contentType: string;
  bytes: Buffer;
}

/** Provider payloads normalise to this. Nothing downstream knows the provider. */
export interface InboundMessage {
  /** The provider's own id, used for idempotent webhook redelivery. */
  providerMessageId: string;
  /**
   * "upload" is a real source, not a stand-in: a file handed to the API
   * directly goes through this same pipeline, and recording it as though it had
   * arrived from a mail provider would misstate how the document was received.
   */
  provider: "postmark" | "mailgun" | "upload";
  /** RFC 5322 Message-ID, stored on the document (`documents.message_id`). */
  messageId?: string;
  /** Envelope recipient - the address that actually routed here. */
  to: string;
  /** Local-part suffix identifying the tenant inbox, when the provider parses one. */
  mailboxHash?: string;
  from: string;
  subject: string;
  receivedAt: Date;
  senderAuth: SenderAuth;
  attachments: RawAttachment[];
}

/** The EN 16931 XML that actually gets validated. */
export interface InvoicePayload {
  filename: string;
  bytes: Buffer;
  sha256: string;
  /** True when the XML was lifted out of a PDF/A-3 container. */
  embedded: boolean;
}

export interface IngestedDocument {
  /**
   * The attachment exactly as received. This is what the archive stores
   * byte-for-byte - for a ZUGFeRD invoice the original is the hybrid PDF, not
   * the XML inside it, and GoBD requires the original.
   */
  filename: string;
  contentType: string;
  bytes: Buffer;
  /** Dedup key over the container. Byte-identical resends collapse onto this. */
  sha256: string;
  sizeBytes: number;
  /** Absent for a paper-equivalent PDF, which is stored but is not an e-invoice. */
  payload?: InvoicePayload;
  detection?: DetectionResult;
  detectionError?: { code: string; message: string };
}

export interface RejectedAttachment {
  filename: string;
  contentType: string;
  sizeBytes: number;
  reason: string;
}

export type IngestWarningCode =
  | "sender_auth_failed"
  | "sender_auth_missing"
  | "no_einvoice_found"
  | "attachment_too_large"
  | "pdf_extraction_failed"
  | "unroutable_recipient";

export interface IngestWarning {
  code: IngestWarningCode;
  message: string;
}

export interface IngestOutcome {
  message: InboundMessage;
  /** Tenant inbox slug parsed from the recipient address, when routable. */
  inboxSlug?: string;
  documents: IngestedDocument[];
  rejected: RejectedAttachment[];
  warnings: IngestWarning[];
}
