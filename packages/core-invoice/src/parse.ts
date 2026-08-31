import { XMLParser } from "fast-xml-parser";
import type {
  Invoice,
  InvoiceLine,
  Party,
  PaymentDetails,
  TaxSubtotal,
} from "./model.js";
import { DetectionError } from "./types.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

type Node = Record<string, unknown>;

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value || undefined;
  if (Array.isArray(value)) return text(value[0]);
  if (value && typeof value === "object") {
    const t = (value as Node)["#text"];
    return typeof t === "string" ? t || undefined : undefined;
  }
  return undefined;
}

function attr(value: unknown, name: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = (value as Node)[`@_${name}`];
  return typeof v === "string" ? v : undefined;
}

function one(node: unknown, name: string): unknown {
  if (!node || typeof node !== "object") return undefined;
  const v = (node as Node)[name];
  return Array.isArray(v) ? v[0] : v;
}

function many(node: unknown, name: string): unknown[] {
  if (!node || typeof node !== "object") return [];
  const v = (node as Node)[name];
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function at(node: unknown, ...names: string[]): unknown {
  return names.reduce<unknown>((acc, n) => one(acc, n), node);
}

/**
 * Parses an amount.
 *
 * Returns undefined rather than NaN or 0 for anything unparseable: a rule that
 * compares against a missing total must see "absent", not "zero". Reading a
 * missing amount as zero is how a validator reports a balanced invoice that
 * does not exist.
 */
function num(value: unknown): number | undefined {
  const raw = text(value);
  if (raw === undefined) return undefined;
  const n = Number(raw.replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

/** CII carries dates as YYYYMMDD (UNTDID 2379 format 102). */
function date(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }
  return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : raw;
}

/* ------------------------------------------------------------------ UBL -- */

function ublParty(node: unknown): Party {
  const party = one(node, "Party");
  const endpoint = one(party, "EndpointID");

  // BT-31 lives in the PartyTaxScheme whose scheme is VAT; a party may carry
  // several registrations and picking the first one silently is a real bug.
  const schemes = many(party, "PartyTaxScheme");
  const vatScheme = schemes.find(
    (s) => (text(at(s, "TaxScheme", "ID")) ?? "").toUpperCase() === "VAT",
  );
  const otherScheme = schemes.find((s) => s !== vatScheme);

  return {
    ...pick("name", text(at(party, "PartyLegalEntity", "RegistrationName")) ??
      text(at(party, "PartyName", "Name"))),
    ...pick("vatId", text(one(vatScheme, "CompanyID"))),
    ...pick("taxNumber", text(one(otherScheme, "CompanyID"))),
    ...pick("countryCode", text(at(party, "PostalAddress", "Country", "IdentificationCode"))),
    ...pick("endpointId", text(endpoint)),
    ...pick("endpointScheme", attr(endpoint, "schemeID")),
  };
}

function ublTaxSubtotals(root: unknown): TaxSubtotal[] {
  const out: TaxSubtotal[] = [];
  for (const total of many(root, "TaxTotal")) {
    for (const sub of many(total, "TaxSubtotal")) {
      const category = one(sub, "TaxCategory");
      out.push({
        ...pick("taxableAmount", num(one(sub, "TaxableAmount"))),
        ...pick("taxAmount", num(one(sub, "TaxAmount"))),
        ...pick("category", text(one(category, "ID"))),
        ...pick("rate", num(one(category, "Percent"))),
        ...pick("exemptionReason", text(one(category, "TaxExemptionReason"))),
        ...pick("exemptionReasonCode", text(one(category, "TaxExemptionReasonCode"))),
      });
    }
  }
  return out;
}

function ublLines(root: unknown): InvoiceLine[] {
  const nodes = [...many(root, "InvoiceLine"), ...many(root, "CreditNoteLine")];
  return nodes.map((line) => {
    const item = one(line, "Item");
    const category = one(item, "ClassifiedTaxCategory");
    const quantity = one(line, "InvoicedQuantity") ?? one(line, "CreditedQuantity");
    return {
      ...pick("id", text(one(line, "ID"))),
      ...pick("name", text(one(item, "Name"))),
      ...pick("description", text(one(item, "Description"))),
      ...pick("quantity", num(quantity)),
      ...pick("unitCode", attr(quantity, "unitCode")),
      ...pick("net", num(one(line, "LineExtensionAmount"))),
      ...pick("category", text(one(category, "ID"))),
      ...pick("rate", num(one(category, "Percent"))),
    };
  });
}

function parseUbl(root: unknown): Invoice {
  const totals = one(root, "LegalMonetaryTotal");
  const means = one(root, "PaymentMeans");
  const account = one(means, "PayeeFinancialAccount");

  const payment: PaymentDetails = {
    ...pick("meansCode", text(one(means, "PaymentMeansCode"))),
    ...pick("reference", text(one(means, "PaymentID"))),
    ...pick("iban", text(one(account, "ID"))),
    ...pick("bic", text(at(account, "FinancialInstitutionBranch", "ID"))),
  };

  return {
    ...pick("invoiceNumber", text(one(root, "ID"))),
    ...pick("issueDate", date(one(root, "IssueDate"))),
    ...pick("dueDate", date(one(root, "DueDate"))),
    ...pick(
      "documentTypeCode",
      text(one(root, "InvoiceTypeCode")) ?? text(one(root, "CreditNoteTypeCode")),
    ),
    ...pick("currency", text(one(root, "DocumentCurrencyCode"))),
    ...pick("buyerReference", text(one(root, "BuyerReference"))),
    ...pick("orderReference", text(at(root, "OrderReference", "ID"))),
    seller: ublParty(one(root, "AccountingSupplierParty")),
    buyer: ublParty(one(root, "AccountingCustomerParty")),
    payment,
    totals: {
      ...pick("lineNet", num(one(totals, "LineExtensionAmount"))),
      ...pick("allowances", num(one(totals, "AllowanceTotalAmount"))),
      ...pick("charges", num(one(totals, "ChargeTotalAmount"))),
      ...pick("taxExclusive", num(one(totals, "TaxExclusiveAmount"))),
      ...pick("taxInclusive", num(one(totals, "TaxInclusiveAmount"))),
      ...pick("prepaid", num(one(totals, "PrepaidAmount"))),
      ...pick("payable", num(one(totals, "PayableAmount"))),
      ...pick("taxTotal", num(at(root, "TaxTotal", "TaxAmount"))),
    },
    taxBreakdown: ublTaxSubtotals(root),
    lines: ublLines(root),
  };
}

/* ------------------------------------------------------------------ CII -- */

function ciiParty(node: unknown): Party {
  const registrations = many(node, "SpecifiedTaxRegistration");
  const vat = registrations.find(
    (r) => (attr(one(r, "ID"), "schemeID") ?? "").toUpperCase() === "VA",
  );
  const fc = registrations.find(
    (r) => (attr(one(r, "ID"), "schemeID") ?? "").toUpperCase() === "FC",
  );
  const uri = at(node, "URIUniversalCommunication", "URIID");

  return {
    ...pick("name", text(one(node, "Name"))),
    ...pick("vatId", text(one(vat, "ID"))),
    ...pick("taxNumber", text(one(fc, "ID"))),
    ...pick("countryCode", text(at(node, "PostalTradeAddress", "CountryID"))),
    ...pick("endpointId", text(uri)),
    ...pick("endpointScheme", attr(uri, "schemeID")),
  };
}

function parseCii(root: unknown): Invoice {
  const doc = one(root, "ExchangedDocument");
  const tx = one(root, "SupplyChainTradeTransaction");
  const agreement = one(tx, "ApplicableHeaderTradeAgreement");
  const settlement = one(tx, "ApplicableHeaderTradeSettlement");
  const summation = one(settlement, "SpecifiedTradeSettlementHeaderMonetarySummation");
  const means = one(settlement, "SpecifiedTradeSettlementPaymentMeans");

  const taxBreakdown: TaxSubtotal[] = many(settlement, "ApplicableTradeTax").map((t) => ({
    ...pick("taxableAmount", num(one(t, "BasisAmount"))),
    ...pick("taxAmount", num(one(t, "CalculatedAmount"))),
    ...pick("category", text(one(t, "CategoryCode"))),
    ...pick("rate", num(one(t, "RateApplicablePercent"))),
    ...pick("exemptionReason", text(one(t, "ExemptionReason"))),
    ...pick("exemptionReasonCode", text(one(t, "ExemptionReasonCode"))),
  }));

  const lines: InvoiceLine[] = many(tx, "IncludedSupplyChainTradeLineItem").map((line) => {
    const lineSettlement = one(line, "SpecifiedLineTradeSettlement");
    const lineTax = one(lineSettlement, "ApplicableTradeTax");
    const quantity = at(line, "SpecifiedLineTradeDelivery", "BilledQuantity");
    const product = one(line, "SpecifiedTradeProduct");
    return {
      ...pick("id", text(at(line, "AssociatedDocumentLineDocument", "LineID"))),
      ...pick("name", text(one(product, "Name"))),
      ...pick("description", text(one(product, "Description"))),
      ...pick("quantity", num(quantity)),
      ...pick("unitCode", attr(quantity, "unitCode")),
      ...pick(
        "net",
        num(
          at(
            lineSettlement,
            "SpecifiedTradeSettlementLineMonetarySummation",
            "LineTotalAmount",
          ),
        ),
      ),
      ...pick("category", text(one(lineTax, "CategoryCode"))),
      ...pick("rate", num(one(lineTax, "RateApplicablePercent"))),
    };
  });

  return {
    ...pick("invoiceNumber", text(one(doc, "ID"))),
    ...pick("issueDate", date(at(doc, "IssueDateTime", "DateTimeString"))),
    ...pick(
      "dueDate",
      date(at(settlement, "SpecifiedTradePaymentTerms", "DueDateDateTime", "DateTimeString")),
    ),
    ...pick("documentTypeCode", text(one(doc, "TypeCode"))),
    ...pick("currency", text(one(settlement, "InvoiceCurrencyCode"))),
    ...pick("buyerReference", text(one(agreement, "BuyerReference"))),
    ...pick("orderReference", text(at(agreement, "BuyerOrderReferencedDocument", "IssuerAssignedID"))),
    seller: ciiParty(one(agreement, "SellerTradeParty")),
    buyer: ciiParty(one(agreement, "BuyerTradeParty")),
    payment: {
      ...pick("meansCode", text(one(means, "TypeCode"))),
      ...pick("reference", text(one(settlement, "PaymentReference"))),
      ...pick("iban", text(at(means, "PayeePartyCreditorFinancialAccount", "IBANID"))),
      ...pick(
        "bic",
        text(at(means, "PayeeSpecifiedCreditorFinancialInstitution", "BICID")),
      ),
    },
    totals: {
      ...pick("lineNet", num(one(summation, "LineTotalAmount"))),
      ...pick("allowances", num(one(summation, "AllowanceTotalAmount"))),
      ...pick("charges", num(one(summation, "ChargeTotalAmount"))),
      ...pick("taxExclusive", num(one(summation, "TaxBasisTotalAmount"))),
      ...pick("taxTotal", num(one(summation, "TaxTotalAmount"))),
      ...pick("taxInclusive", num(one(summation, "GrandTotalAmount"))),
      ...pick("prepaid", num(one(summation, "TotalPrepaidAmount"))),
      ...pick("payable", num(one(summation, "DuePayableAmount"))),
    },
    taxBreakdown,
    lines,
  };
}

/** Keeps optional properties absent rather than explicitly undefined. */
function pick<K extends string, V>(key: K, value: V | undefined): Record<K, V> | object {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/**
 * Parses an EN 16931 document into the normalised model.
 *
 * Never throws on missing content - a ZUGFeRD MINIMUM document legitimately has
 * no lines, and D-001 is what judges that, not the parser. It throws only when
 * the input is not a recognisable invoice at all.
 */
export function parseInvoice(input: Buffer | string): Invoice {
  const raw = typeof input === "string" ? input : input.toString("utf8");
  const xml = raw.replace(/^﻿/, "").trimStart();

  if (!xml.startsWith("<")) {
    throw new DetectionError("Input is not XML.", "not_xml");
  }

  const doc = parser.parse(xml) as Node;
  const rootName = Object.keys(doc).find((k) => !k.startsWith("?")) ?? "";
  const root = doc[rootName];

  if (rootName === "Invoice" || rootName === "CreditNote") return parseUbl(root);
  if (rootName === "CrossIndustryInvoice") return parseCii(root);

  throw new DetectionError(
    `Unknown root element <${rootName || "?"}>. Expected Invoice, CreditNote or CrossIndustryInvoice.`,
    "unknown_root",
  );
}
