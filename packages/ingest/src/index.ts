export {
  generateInboxAddress,
  parseInboxAddress,
  slugify,
  type InboxAddress,
  type ParsedInbox,
} from "./address.js";
export {
  hasAuthFailure,
  isUnauthenticated,
  parseAuthenticationResults,
} from "./auth-results.js";
export {
  extractEmbeddedFiles,
  looksLikePdf,
  looksLikeXml,
  selectInvoiceCandidates,
  type EmbeddedFile,
  type PdfExtractionResult,
} from "./pdf.js";
export {
  DEFAULT_MAX_ATTACHMENT_BYTES,
  ingestMessage,
  sha256,
  type IngestOptions,
} from "./pipeline.js";
export { findHeader, type IngestSource, type VerificationResult } from "./sources/source.js";
export {
  postmarkSource,
  type PostmarkInboundPayload,
  type PostmarkRequest,
  type PostmarkSourceOptions,
} from "./sources/postmark.js";
export {
  mailgunSource,
  type MailgunRequest,
  type MailgunSourceOptions,
} from "./sources/mailgun.js";
export type {
  AuthVerdict,
  InboundMessage,
  IngestOutcome,
  IngestWarning,
  IngestWarningCode,
  IngestedDocument,
  InvoicePayload,
  RawAttachment,
  RejectedAttachment,
  SenderAuth,
} from "./types.js";
