import type { Invoice, InvoiceLine, TaxSubtotal } from "@belegbox/core-invoice";

/**
 * The field vocabulary rules may address.
 *
 * A whitelist, not a path walker. `doc.constructor.prototype` is not a field,
 * and neither is anything else a tenant might think to try - the resolver only
 * knows these names. Adding a field is a deliberate act.
 */

export type IterationScope = "document" | "line" | "tax";

export interface ResolutionScope {
  invoice: Invoice;
  direction: "incoming" | "outgoing";
  line?: InvoiceLine;
  lineIndex?: number;
  tax?: TaxSubtotal;
  taxIndex?: number;
  /** Values produced by earlier `compute` actions in the same rule. */
  vars?: Record<string, number>;
}

/** Leitweg-ID: 2-12 digits, dash, up to 30 alphanumerics, dash, 2 digits. */
export const LEITWEG_ID = /^\d{2,12}-[A-Za-z0-9]{1,30}-\d{2}$/;

const DOC: Record<string, (s: ResolutionScope) => unknown> = {
  "doc.invoice_number": (s) => s.invoice.invoiceNumber,
  "doc.issue_date": (s) => s.invoice.issueDate,
  "doc.due_date": (s) => s.invoice.dueDate,
  "doc.type_code": (s) => s.invoice.documentTypeCode,
  "doc.currency": (s) => s.invoice.currency,
  "doc.buyer_reference": (s) => s.invoice.buyerReference,
  "doc.order_reference": (s) => s.invoice.orderReference,
  "doc.direction": (s) => s.direction,
  "doc.total_net": (s) => s.invoice.totals.taxExclusive,
  "doc.total_vat": (s) => s.invoice.totals.taxTotal,
  "doc.total_gross": (s) => s.invoice.totals.taxInclusive,
  "doc.line_net_total": (s) => s.invoice.totals.lineNet,
  "doc.prepaid": (s) => s.invoice.totals.prepaid,
  "doc.payable": (s) => s.invoice.totals.payable,
  "doc.line_count": (s) => s.invoice.lines.length,
  "doc.tax_category_count": (s) => new Set(s.invoice.taxBreakdown.map((t) => t.category)).size,
  // A Leitweg-ID in BT-10 is what makes a document B2G in practice: public
  // buyers are addressed by it, and the portals reject anything without one.
  "doc.is_b2g": (s) => LEITWEG_ID.test(s.invoice.buyerReference ?? ""),

  "supplier.name": (s) => s.invoice.seller.name,
  "supplier.vat_id": (s) => s.invoice.seller.vatId,
  "supplier.tax_number": (s) => s.invoice.seller.taxNumber,
  "supplier.country": (s) => s.invoice.seller.countryCode,
  "supplier.vat_id_country": (s) => countryOfVatId(s.invoice.seller.vatId),

  "buyer.name": (s) => s.invoice.buyer.name,
  "buyer.vat_id": (s) => s.invoice.buyer.vatId,
  "buyer.country": (s) => s.invoice.buyer.countryCode,

  "payment.iban": (s) => s.invoice.payment.iban,
  "payment.bic": (s) => s.invoice.payment.bic,
  "payment.means_code": (s) => s.invoice.payment.meansCode,
  "payment.reference": (s) => s.invoice.payment.reference,
  "payment.iban_country": (s) => countryOfIban(s.invoice.payment.iban),
};

const LINE: Record<string, (line: InvoiceLine, s: ResolutionScope) => unknown> = {
  "line.id": (l) => l.id,
  // Name and description are one searchable string: suppliers put the useful
  // words in whichever of the two they feel like.
  "line.description": (l) => [l.name, l.description].filter(Boolean).join(" ") || undefined,
  "line.name": (l) => l.name,
  "line.net": (l) => l.net,
  "line.quantity": (l) => l.quantity,
  "line.unit": (l) => l.unitCode,
  "line.vat_rate": (l) => l.rate,
  "line.vat_category": (l) => l.category,
  "line.index": (_l, s) => s.lineIndex,
};

const TAX: Record<string, (tax: TaxSubtotal, s: ResolutionScope) => unknown> = {
  "tax.category": (t) => t.category,
  "tax.rate": (t) => t.rate,
  "tax.taxable_amount": (t) => t.taxableAmount,
  "tax.tax_amount": (t) => t.taxAmount,
  "tax.exemption_reason": (t) => t.exemptionReason,
  "tax.exemption_code": (t) => t.exemptionReasonCode,
  "tax.index": (_t, s) => s.taxIndex,
};

export function countryOfVatId(vatId: string | undefined): string | undefined {
  const m = /^([A-Z]{2})/i.exec((vatId ?? "").trim());
  return m?.[1]?.toUpperCase();
}

export function countryOfIban(iban: string | undefined): string | undefined {
  const m = /^([A-Z]{2})/i.exec((iban ?? "").replace(/\s+/g, ""));
  return m?.[1]?.toUpperCase();
}

export function knownFields(): string[] {
  return [...Object.keys(DOC), ...Object.keys(LINE), ...Object.keys(TAX)].sort();
}

export function isKnownField(path: string): boolean {
  return (
    path in DOC || path in LINE || path in TAX || path.startsWith("var.")
  );
}

/** Which collection a field forces the rule to iterate over. */
export function scopeOfField(path: string): IterationScope {
  if (path in LINE) return "line";
  if (path in TAX) return "tax";
  return "document";
}

export function resolveField(path: string, scope: ResolutionScope): unknown {
  if (path.startsWith("var.")) {
    return scope.vars?.[path.slice(4)];
  }

  const doc = DOC[path];
  if (doc) return doc(scope);

  const line = LINE[path];
  if (line) {
    // A line field outside a line iteration is a rule authoring mistake, and
    // returning undefined would let the rule quietly match nothing forever.
    if (!scope.line) return undefined;
    return line(scope.line, scope);
  }

  const tax = TAX[path];
  if (tax) {
    if (!scope.tax) return undefined;
    return tax(scope.tax, scope);
  }

  return undefined;
}
