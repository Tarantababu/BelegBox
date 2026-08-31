/** UN/CEFACT CII or OASIS UBL. Everything EN 16931 is one of the two. */
export type Syntax = "ubl" | "cii";

/** Mirrors `documents.format` in the data model (see docs/IMPLEMENTATION_PLAN.md). */
export type DocumentFormat =
  | "xrechnung_ubl"
  | "xrechnung_cii"
  | "zugferd"
  | "peppol_bis"
  | "other";

/**
 * D-001. ZUGFeRD MINIMUM and BASIC WL carry no line-level data and are not
 * e-invoices in the sense of § 14 UStG - they are accounting previews. Most
 * suppliers sending them believe they are compliant.
 */
export type LegalClass = "einvoice" | "not_einvoice";

export interface ProfileInfo {
  /** The guideline URN exactly as it appeared in the document. */
  urn: string;
  /** Human-readable profile name, e.g. "ZUGFeRD 2.x MINIMUM". */
  name: string;
  legalClass: LegalClass;
  /** Set when the profile identifies a specific national CIUS version. */
  cius?: string;
}

export interface DetectionResult {
  syntax: Syntax;
  format: DocumentFormat;
  /** Root element local name: Invoice, CreditNote, CrossIndustryInvoice. */
  rootElement: string;
  profile: ProfileInfo;
  /** BT-1 invoice number, when present. Used for D-007 duplicate detection. */
  invoiceNumber?: string;
  /** BT-2 issue date (ISO). Rule selection keys off this, never off now(). */
  issueDate?: string;
  /** BT-3 document type code (UNTDID 1001): 380, 381, 384, 389. */
  documentTypeCode?: string;
}

export class DetectionError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_xml"
      | "pdf_container"
      | "unknown_root"
      | "missing_profile",
  ) {
    super(message);
    this.name = "DetectionError";
  }
}
