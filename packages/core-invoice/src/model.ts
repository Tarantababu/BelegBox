/**
 * Normalised invoice, syntax-agnostic.
 *
 * UBL and CII say the same things with different tag names. Rules must never
 * have to know which one arrived, so both parse into this. Field comments carry
 * the EN 16931 business term, because that is the vocabulary the rules, the
 * findings and the legal citations all speak.
 */

export interface Party {
  /** BT-27 / BT-44 registered name. */
  name?: string;
  /** BT-31 / BT-48 VAT identifier, e.g. DE123456789. */
  vatId?: string;
  /** BT-32 local tax registration, where a VAT id is absent. */
  taxNumber?: string;
  /** BT-40 / BT-55 country code. */
  countryCode?: string;
  /** BT-34 / BT-49 electronic address. */
  endpointId?: string;
  endpointScheme?: string;
}

export interface TaxSubtotal {
  /** BT-116 taxable amount for this category. */
  taxableAmount?: number;
  /** BT-117 tax amount for this category. */
  taxAmount?: number;
  /** BT-118 UNTDID 5305 category: S, Z, E, AE, K, G, O. */
  category?: string;
  /** BT-119 rate as a percentage. */
  rate?: number;
  /** BT-120 exemption reason text. */
  exemptionReason?: string;
  /** BT-121 exemption reason code. */
  exemptionReasonCode?: string;
}

export interface InvoiceLine {
  /** BT-126 line identifier. */
  id?: string;
  /** BT-153 item name, and BT-154 description when present. */
  name?: string;
  description?: string;
  /** BT-129 invoiced quantity, BT-130 unit. */
  quantity?: number;
  unitCode?: string;
  /** BT-131 line net amount. */
  net?: number;
  /** BT-151 line VAT category. */
  category?: string;
  /** BT-152 line VAT rate. */
  rate?: number;
}

export interface InvoiceTotals {
  /** BT-106 sum of line net amounts. */
  lineNet?: number;
  /** BT-107 / BT-108 document level allowances and charges. */
  allowances?: number;
  charges?: number;
  /** BT-109 total without VAT. */
  taxExclusive?: number;
  /** BT-110 total VAT amount. */
  taxTotal?: number;
  /** BT-112 total with VAT. */
  taxInclusive?: number;
  /** BT-113 paid amount. Carries Abschlagsrechnung offsets in construction. */
  prepaid?: number;
  /** BT-115 amount due for payment. */
  payable?: number;
}

export interface PaymentDetails {
  /** BT-81 UNTDID 4461 means code: 58 SEPA credit transfer, 59 direct debit. */
  meansCode?: string;
  /** BT-83 remittance information. */
  reference?: string;
  /** BT-84 payee account. */
  iban?: string;
  /** BT-86 payee institution. */
  bic?: string;
}

export interface Invoice {
  /** BT-1 invoice number. */
  invoiceNumber?: string;
  /** BT-2 issue date, ISO. Rule selection keys off this, never off now(). */
  issueDate?: string;
  /** BT-9 payment due date, ISO. */
  dueDate?: string;
  /** BT-3 UNTDID 1001: 380 invoice, 381 credit note, 384 corrected. */
  documentTypeCode?: string;
  /** BT-5 currency. */
  currency?: string;
  /** BT-10 buyer reference. Carries the Leitweg-ID on a B2G invoice. */
  buyerReference?: string;
  /** BT-13 purchase order reference. */
  orderReference?: string;

  seller: Party;
  buyer: Party;
  payment: PaymentDetails;
  totals: InvoiceTotals;
  /** BG-23 VAT breakdown, one entry per category and rate. */
  taxBreakdown: TaxSubtotal[];
  /** BG-25 invoice lines. Empty for ZUGFeRD MINIMUM and BASIC WL. */
  lines: InvoiceLine[];
}
