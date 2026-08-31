import { createHash } from "node:crypto";
import { DetectionError, detect } from "@belegbox/core-invoice";
import { parseInboxAddress } from "./address.js";
import { hasAuthFailure, isUnauthenticated } from "./auth-results.js";
import {
  extractEmbeddedFiles,
  looksLikePdf,
  looksLikeXml,
  selectInvoiceCandidates,
  type EmbeddedFile,
} from "./pdf.js";
import type {
  InboundMessage,
  IngestOutcome,
  IngestWarning,
  IngestedDocument,
  InvoicePayload,
  RawAttachment,
  RejectedAttachment,
} from "./types.js";

/** Postmark caps inbound at 35 MB; a real e-invoice is orders of magnitude smaller. */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface IngestOptions {
  maxAttachmentBytes?: number;
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Turns one inbound email into the documents it carries.
 *
 * Three rules shape this function:
 *
 * 1. Nothing is dropped for being unrecognised. A PDF with no embedded XML is
 *    still a document the tenant is legally required to keep (§ 14b UStG) - it
 *    becomes `not_einvoice`, not garbage.
 * 2. Authentication failures warn, they never block. A legitimate supplier with
 *    a broken SPF record must not have their invoice silently disappear; the
 *    warning surfaces in the UI and feeds D-008.
 * 3. Parsing never throws. Malformed input is data, and this code path is
 *    reachable by anyone who learns the address.
 */
export function ingestMessage(
  message: InboundMessage,
  opts: IngestOptions = {},
): IngestOutcome {
  const maxBytes = opts.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
  const warnings: IngestWarning[] = [];
  const rejected: RejectedAttachment[] = [];
  const documents: IngestedDocument[] = [];

  // --- routing -------------------------------------------------------------
  const parsed =
    parseInboxAddress(message.to) ??
    (message.mailboxHash ? parseInboxAddress(`${message.mailboxHash}@x`) : null);

  if (!parsed) {
    warnings.push({
      code: "unroutable_recipient",
      message: `Recipient "${message.to}" does not match a tenant inbox address.`,
    });
  }

  // --- sender authentication ----------------------------------------------
  if (hasAuthFailure(message.senderAuth)) {
    warnings.push({
      code: "sender_auth_failed",
      message: `Sender authentication failed (spf=${message.senderAuth.spf}, dkim=${message.senderAuth.dkim}, dmarc=${message.senderAuth.dmarc}). Treat the bank details on this document as unverified.`,
    });
  } else if (isUnauthenticated(message.senderAuth)) {
    warnings.push({
      code: "sender_auth_missing",
      message: `No sender authentication (spf=${message.senderAuth.spf}, dkim=${message.senderAuth.dkim}, dmarc=${message.senderAuth.dmarc}).`,
    });
  }

  // --- attachments ---------------------------------------------------------
  const seen = new Set<string>();

  for (const attachment of message.attachments) {
    if (attachment.bytes.length === 0) {
      rejected.push(reject(attachment, "Empty attachment."));
      continue;
    }
    if (attachment.bytes.length > maxBytes) {
      warnings.push({
        code: "attachment_too_large",
        message: `"${attachment.filename}" is ${attachment.bytes.length} bytes, over the ${maxBytes} byte limit.`,
      });
      rejected.push(reject(attachment, `Over the ${maxBytes} byte limit.`));
      continue;
    }

    const isPdf = looksLikePdf(attachment.bytes);
    const isXml = !isPdf && looksLikeXml(attachment.bytes);

    if (!isPdf && !isXml) {
      // Content sniffing beats the filename here: suppliers mislabel constantly,
      // and a claimed content type is attacker-controlled.
      rejected.push(
        reject(
          attachment,
          "Neither XML nor PDF. Logos, terms and delivery notes ride along with real invoices.",
        ),
      );
      continue;
    }

    const digest = sha256(attachment.bytes);
    if (seen.has(digest)) continue; // same file attached twice
    seen.add(digest);

    const payload = isPdf
      ? payloadFromPdf(attachment, warnings)
      : {
          filename: attachment.filename,
          bytes: attachment.bytes,
          sha256: digest,
          embedded: false,
        };

    documents.push(
      buildDocument(attachment, digest, payload),
    );
  }

  if (documents.every((d) => d.detection === undefined)) {
    warnings.push({
      code: "no_einvoice_found",
      message:
        documents.length === 0
          ? "No XML or PDF attachment in this message."
          : "No EN 16931 XML in this message. Stored as a paper-equivalent document.",
    });
  }

  return {
    message,
    ...(parsed ? { inboxSlug: parsed.slug } : {}),
    documents,
    rejected,
    warnings,
  };
}

function reject(attachment: RawAttachment, reason: string): RejectedAttachment {
  return {
    filename: attachment.filename,
    contentType: attachment.contentType,
    sizeBytes: attachment.bytes.length,
    reason,
  };
}

function payloadFromPdf(
  attachment: RawAttachment,
  warnings: IngestWarning[],
): InvoicePayload | undefined {
  const extraction = extractEmbeddedFiles(attachment.bytes);
  const candidates = selectInvoiceCandidates(extraction.files);

  if (candidates.length === 0) {
    warnings.push({
      code: "pdf_extraction_failed",
      message: `"${attachment.filename}": ${extraction.problem ?? "no embedded invoice XML."}`,
    });
    return undefined;
  }

  // Prefer a candidate the detector actually recognises over the first one found.
  const chosen = candidates.find(detectable) ?? (candidates[0] as EmbeddedFile);
  return {
    filename: chosen.filename,
    bytes: chosen.bytes,
    sha256: sha256(chosen.bytes),
    embedded: true,
  };
}

function detectable(file: EmbeddedFile): boolean {
  try {
    detect(file.bytes);
    return true;
  } catch {
    return false;
  }
}

function buildDocument(
  attachment: RawAttachment,
  digest: string,
  payload: InvoicePayload | undefined,
): IngestedDocument {
  const base = {
    filename: attachment.filename,
    contentType: attachment.contentType,
    bytes: attachment.bytes,
    sha256: digest,
    sizeBytes: attachment.bytes.length,
  };

  if (!payload) {
    return {
      ...base,
      detectionError: {
        code: "no_payload",
        message: "No EN 16931 XML found in this attachment.",
      },
    };
  }

  try {
    return { ...base, payload, detection: detect(payload.bytes) };
  } catch (err) {
    const code = err instanceof DetectionError ? err.code : "unknown";
    return {
      ...base,
      payload,
      detectionError: { code, message: (err as Error).message },
    };
  }
}
