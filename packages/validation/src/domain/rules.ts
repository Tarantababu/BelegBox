import type { DetectionResult, Invoice } from "@belegbox/core-invoice";
import { countryOfIban, countryOfVatId, LEITWEG_ID } from "@belegbox/rules-engine";
import type { EngineVersions, Finding, Severity } from "../types.js";

/**
 * L3 - the domain layer.
 *
 * These are code rather than YAML because they are the moat: they need lookups,
 * history and arithmetic that a declarative rule cannot express, and they are
 * the same for every tenant. D-007, D-008 and D-009 in particular are not
 * e-invoicing checks at all - they are invoice-fraud checks, and no competing
 * validator runs them.
 *
 * Every rule here abstains rather than guesses. A check that cannot reach an
 * answer produces a warning saying so, never a content error.
 */

/** Categories where EN 16931 requires an exemption reason in BT-120 or BT-121. */
const REASON_REQUIRED = new Set(["AE", "E", "K", "G", "Z"]);

/** Categories that must carry a zero rate. */
const ZERO_RATED = new Set(["AE", "E", "K", "G", "Z", "O"]);

/** German domestic rates. Anything else on a domestic invoice is worth a look. */
const GERMAN_RATES = new Set([0, 7, 19]);

/** EU member state codes, for deciding when a VIES check is even relevant. */
const EU = new Set([
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR",
  "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK",
]);

/** D-009 needs a baseline before it can call anything unusual. */
const MIN_HISTORY_FOR_OUTLIER = 6;
const OUTLIER_FACTOR = 3;

export interface SupplierHistory {
  /** D-007: has this supplier already sent this invoice number? */
  hasInvoiceNumber(supplierVatId: string, invoiceNumber: string): Promise<boolean>;
  /** D-009: rolling 12-month statistics for this supplier. */
  amountStats(
    supplierVatId: string,
  ): Promise<{ count: number; mean: number } | undefined>;
}

export interface ViesLookup {
  /** undefined when the service could not be reached - never a guess. */
  check(vatId: string): Promise<boolean | undefined>;
}

export interface DomainContext {
  invoice: Invoice;
  detection: DetectionResult;
  versions: EngineVersions;
  direction: "incoming" | "outgoing";
  history?: SupplierHistory;
  vies?: ViesLookup;
}

function finding(
  ctx: DomainContext,
  code: string,
  severity: Severity,
  explainKey: string,
  messageRaw: string,
  extra: {
    btRef?: string;
    legalBasis?: string;
    params?: Record<string, string | number>;
  } = {},
): Finding {
  return {
    layer: "l3_domain",
    code,
    severity,
    ...(extra.btRef ? { btRef: extra.btRef } : {}),
    ...(extra.legalBasis ? { legalBasis: extra.legalBasis } : {}),
    messageRaw,
    explainKey,
    ...(extra.params ? { params: extra.params } : {}),
    versions: ctx.versions,
  };
}

/** D-001 - the profile is not legally an e-invoice. */
function d001(ctx: DomainContext): Finding[] {
  if (ctx.detection.profile.legalClass !== "not_einvoice") return [];
  return [
    finding(
      ctx,
      "D-001",
      "warning",
      "domain.d001.not_an_einvoice",
      `Profile "${ctx.detection.profile.urn}" (${ctx.detection.profile.name}) carries no line-level data and is not an e-invoice.`,
      {
        btRef: "BT-24",
        legalBasis: "§ 14 Abs. 1 UStG",
        params: {
          profile_urn: ctx.detection.profile.urn,
          profile_name: ctx.detection.profile.name,
        },
      },
    ),
  ];
}

/** D-002 - exemption category without the reason EN 16931 requires. */
function d002(ctx: DomainContext): Finding[] {
  const out: Finding[] = [];
  ctx.invoice.taxBreakdown.forEach((tax, index) => {
    const category = (tax.category ?? "").toUpperCase();
    if (!REASON_REQUIRED.has(category)) return;
    if (tax.exemptionReason?.trim() || tax.exemptionReasonCode?.trim()) return;

    out.push(
      finding(
        ctx,
        "D-002",
        "content_error",
        "domain.d002.exemption_reason_missing",
        `VAT category ${category} is used without an exemption reason (BT-120) or reason code (BT-121).`,
        {
          btRef: "BT-120",
          legalBasis:
            category === "AE"
              ? "§ 13b UStG, § 14 Abs. 4 Satz 1 Nr. 10 UStG"
              : "§ 4 UStG, § 14 Abs. 4 UStG",
          params: { vat_category: category, breakdown_index: index },
        },
      ),
    );
  });
  return out;
}

/** D-003 - a buyer reference that was meant to be a Leitweg-ID and is malformed. */
function d003(ctx: DomainContext): Finding[] {
  const reference = ctx.invoice.buyerReference?.trim();
  if (!reference) return [];
  if (LEITWEG_ID.test(reference)) return [];

  // BT-10 is a free buyer reference in general, so only something clearly
  // *shaped* like a Leitweg-ID is judged. Flagging every purchase-order number
  // would make this rule noise, and noise is how a real finding gets ignored.
  if (!/^\d{2,}-/.test(reference)) return [];

  return [
    finding(
      ctx,
      "D-003",
      "content_error",
      "domain.d003.leitweg_id_malformed",
      `Buyer reference "${reference}" looks like a Leitweg-ID but does not match the required format (for example 04011000-1234512345-06).`,
      {
        btRef: "BT-10",
        legalBasis: "§ 4 E-Rechnungsverordnung",
        params: { buyer_reference: reference },
      },
    ),
  ];
}

/** D-004 - intra-EU counterparty whose VAT id VIES does not confirm. */
async function d004(ctx: DomainContext): Promise<Finding[]> {
  const counterparty =
    ctx.direction === "incoming" ? ctx.invoice.seller : ctx.invoice.buyer;
  const vatId = counterparty.vatId?.replace(/\s+/g, "").toUpperCase();
  if (!vatId) return [];

  const country = countryOfVatId(vatId);
  // A domestic German VAT id is not a VIES matter, and cross-border rules are a
  // separate regime entirely.
  if (!country || country === "DE" || !EU.has(country)) return [];
  if (!ctx.vies) return [];

  const valid = await ctx.vies.check(vatId);

  if (valid === undefined) {
    // VIES is down often enough that this is the normal path, not the edge one.
    return [
      finding(
        ctx,
        "D-004",
        "warning",
        "domain.d004.vies_unavailable",
        `VAT identifier ${vatId} could not be checked against VIES; the service did not answer.`,
        { btRef: "BT-31", params: { vat_id: vatId } },
      ),
    ];
  }
  if (valid) return [];

  return [
    finding(
      ctx,
      "D-004",
      "content_error",
      "domain.d004.vat_id_invalid",
      `VAT identifier ${vatId} is not registered in VIES.`,
      {
        btRef: "BT-31",
        legalBasis: "§ 6a Abs. 1 UStG, § 18e UStG",
        params: { vat_id: vatId },
      },
    ),
  ];
}

/** D-005 - the VAT rate and the category code contradict each other. */
function d005(ctx: DomainContext): Finding[] {
  const out: Finding[] = [];

  ctx.invoice.taxBreakdown.forEach((tax, index) => {
    const category = (tax.category ?? "").toUpperCase();
    const rate = tax.rate;
    if (!category || rate === undefined) return;

    if (ZERO_RATED.has(category) && rate > 0) {
      out.push(
        finding(
          ctx,
          "D-005",
          "content_error",
          "domain.d005.rate_category_mismatch",
          `VAT category ${category} carries a rate of ${rate} %, but this category must be zero-rated.`,
          {
            btRef: "BT-119",
            params: { vat_category: category, vat_rate: rate, breakdown_index: index },
          },
        ),
      );
      return;
    }

    if (category === "S" && rate === 0) {
      out.push(
        finding(
          ctx,
          "D-005",
          "content_error",
          "domain.d005.standard_rate_zero",
          "VAT category S (standard rate) carries a rate of 0 %. An exempt or zero-rated supply needs its own category.",
          { btRef: "BT-119", params: { vat_category: category, breakdown_index: index } },
        ),
      );
      return;
    }

    const domestic =
      (ctx.invoice.seller.countryCode ?? "DE") === "DE" &&
      (ctx.invoice.buyer.countryCode ?? "DE") === "DE";
    if (category === "S" && domestic && !GERMAN_RATES.has(rate)) {
      out.push(
        finding(
          ctx,
          "D-005",
          "warning",
          "domain.d005.unusual_rate",
          `A domestic invoice uses a VAT rate of ${rate} %. German rates are 19 % and 7 %.`,
          { btRef: "BT-119", params: { vat_rate: rate, breakdown_index: index } },
        ),
      );
    }
  });

  return out;
}

/** D-006 - due before issued. */
function d006(ctx: DomainContext): Finding[] {
  const { issueDate, dueDate } = ctx.invoice;
  if (!issueDate || !dueDate || dueDate >= issueDate) return [];

  return [
    finding(
      ctx,
      "D-006",
      "content_error",
      "domain.d006.due_before_issue",
      `Payment due date ${dueDate} is earlier than the invoice date ${issueDate}.`,
      {
        btRef: "BT-9",
        params: { issue_date: issueDate, due_date: dueDate },
      },
    ),
  ];
}

/** D-007 - the same supplier and invoice number arrived before. */
async function d007(ctx: DomainContext): Promise<Finding[]> {
  const vatId = ctx.invoice.seller.vatId;
  const number = ctx.invoice.invoiceNumber;
  if (!ctx.history || !vatId || !number) return [];

  if (!(await ctx.history.hasInvoiceNumber(vatId, number))) return [];

  return [
    finding(
      ctx,
      "D-007",
      "content_error",
      "domain.d007.duplicate_invoice",
      `Invoice number ${number} from ${vatId} has already been received. Paying it twice is the usual outcome.`,
      {
        btRef: "BT-1",
        legalBasis: "§ 14c Abs. 1 UStG",
        params: { invoice_number: number, supplier_vat_id: vatId },
      },
    ),
  ];
}

/**
 * D-008 - the payment account is in a different country from the supplier.
 *
 * The classic invoice-fraud signal: a real supplier relationship, a real
 * invoice, and an IBAN swapped for one the attacker controls. Legitimate cases
 * exist - a German company banking in Luxembourg is ordinary - so this is a
 * warning that asks for a phone call, not an error that blocks a payment.
 */
function d008(ctx: DomainContext): Finding[] {
  const vatCountry = countryOfVatId(ctx.invoice.seller.vatId);
  const ibanCountry = countryOfIban(ctx.invoice.payment.iban);
  if (!vatCountry || !ibanCountry || vatCountry === ibanCountry) return [];

  return [
    finding(
      ctx,
      "D-008",
      "warning",
      "domain.d008.iban_country_mismatch",
      `Supplier VAT identifier is registered in ${vatCountry}, but the payment account is in ${ibanCountry}.`,
      {
        btRef: "BT-84",
        params: {
          vat_country: vatCountry,
          iban_country: ibanCountry,
          iban: ctx.invoice.payment.iban ?? "",
        },
      },
    ),
  ];
}

/** D-009 - the amount is far outside this supplier's usual range. */
async function d009(ctx: DomainContext): Promise<Finding[]> {
  const vatId = ctx.invoice.seller.vatId;
  const gross = ctx.invoice.totals.taxInclusive;
  if (!ctx.history || !vatId || gross === undefined) return [];

  const stats = await ctx.history.amountStats(vatId);
  // Without a baseline every new supplier's first invoice is an outlier, which
  // would open every relationship with a false fraud alert.
  if (!stats || stats.count < MIN_HISTORY_FOR_OUTLIER || stats.mean <= 0) return [];

  const factor = gross / stats.mean;
  if (factor <= OUTLIER_FACTOR) return [];

  return [
    finding(
      ctx,
      "D-009",
      "warning",
      "domain.d009.amount_outlier",
      `This invoice is ${factor.toFixed(1)}x the 12-month average of ${stats.mean.toFixed(2)} for this supplier, across ${stats.count} invoices.`,
      {
        btRef: "BT-112",
        params: {
          gross_amount: gross,
          mean_amount: Math.round(stats.mean * 100) / 100,
          factor: Math.round(factor * 10) / 10,
          sample_size: stats.count,
        },
      },
    ),
  ];
}

/**
 * Runs every domain rule.
 *
 * D-001 runs even on a document with no lines; the rest need parsed content and
 * are skipped when the profile already says there is none, because reporting
 * "no exemption reason" on a MINIMUM profile that structurally cannot carry one
 * is noise on top of the finding that matters.
 */
export async function runDomainRules(ctx: DomainContext): Promise<Finding[]> {
  const findings = [...d001(ctx)];

  if (ctx.detection.profile.legalClass === "not_einvoice") return findings;

  findings.push(...d002(ctx), ...d003(ctx), ...d005(ctx), ...d006(ctx), ...d008(ctx));

  const [vies, duplicate, outlier] = await Promise.all([d004(ctx), d007(ctx), d009(ctx)]);
  findings.push(...vies, ...duplicate, ...outlier);

  return findings;
}

export const DOMAIN_RULE_CODES = [
  "D-001",
  "D-002",
  "D-003",
  "D-004",
  "D-005",
  "D-006",
  "D-007",
  "D-008",
  "D-009",
] as const;
