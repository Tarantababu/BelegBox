import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { detect, parseInvoice, type DetectionResult, type Invoice } from "@belegbox/core-invoice";
import { describe, expect, it } from "vitest";
import type { EngineVersions } from "../types.js";
import { runDomainRules, type SupplierHistory, type ViesLookup } from "./rules.js";

const CORPUS = join(import.meta.dirname, "../../../../corpus");
const fixture = (name: string) => readFile(join(CORPUS, name));

const versions: EngineVersions = {
  validatorConfigVersion: "test-config",
  engineVersion: "test-engine",
};

async function load(name: string): Promise<{ invoice: Invoice; detection: DetectionResult }> {
  const bytes = await fixture(name);
  return { invoice: parseInvoice(bytes), detection: detect(bytes) };
}

async function run(
  name: string,
  over: Partial<Invoice> = {},
  ports: { history?: SupplierHistory; vies?: ViesLookup } = {},
) {
  const { invoice, detection } = await load(name);
  return runDomainRules({
    invoice: { ...invoice, ...over },
    detection,
    versions,
    direction: "incoming",
    ...ports,
  });
}

const codes = (findings: Awaited<ReturnType<typeof run>>) => findings.map((f) => f.code);

describe("D-001 profile legality", () => {
  it("flags a MINIMUM profile", async () => {
    const findings = await run("zugferd-minimum-01.xml");
    expect(codes(findings)).toEqual(["D-001"]);
    expect(findings[0]?.legalBasis).toBe("§ 14 Abs. 1 UStG");
  });

  // A MINIMUM profile structurally cannot carry an exemption reason. Reporting
  // that on top of D-001 is noise stacked on the finding that matters.
  it("suppresses the other rules once the document is not an e-invoice", async () => {
    const findings = await run("zugferd-minimum-01.xml", {
      taxBreakdown: [{ category: "AE", rate: 0, taxAmount: 0 }],
      dueDate: "2020-01-01",
      issueDate: "2026-08-18",
    });
    expect(codes(findings)).toEqual(["D-001"]);
  });
});

describe("D-002 missing exemption reason", () => {
  it("flags reverse charge with neither BT-120 nor BT-121", async () => {
    const findings = await run("missing-exemption-reason-ae-01.xml");
    const d002 = findings.find((f) => f.code === "D-002");
    expect(d002?.severity).toBe("content_error");
    expect(d002?.btRef).toBe("BT-120");
    expect(d002?.legalBasis).toContain("§ 13b UStG");
  });

  it("accepts a reason in BT-120", async () => {
    const findings = await run("missing-exemption-reason-ae-01.xml", {
      taxBreakdown: [
        {
          category: "AE",
          rate: 0,
          taxAmount: 0,
          taxableAmount: 4200,
          exemptionReason: "Steuerschuldnerschaft des Leistungsempfängers",
        },
      ],
    });
    expect(codes(findings)).not.toContain("D-002");
  });

  it("accepts a code in BT-121", async () => {
    const findings = await run("missing-exemption-reason-ae-01.xml", {
      taxBreakdown: [
        { category: "AE", rate: 0, taxAmount: 0, exemptionReasonCode: "VATEX-EU-AE" },
      ],
    });
    expect(codes(findings)).not.toContain("D-002");
  });

  it("applies to every category that needs a reason", async () => {
    for (const category of ["AE", "E", "K", "G", "Z"]) {
      const findings = await run("xrechnung-ubl-valid-01.xml", {
        taxBreakdown: [{ category, rate: 0, taxAmount: 0 }],
      });
      expect(codes(findings), category).toContain("D-002");
    }
  });

  it("does not apply to the standard rate", async () => {
    expect(codes(await run("xrechnung-ubl-valid-01.xml"))).not.toContain("D-002");
  });
});

describe("D-003 malformed Leitweg-ID", () => {
  it("accepts a well-formed Leitweg-ID", async () => {
    const findings = await run("xrechnung-ubl-valid-01.xml", {
      buyerReference: "04011000-1234512345-06",
    });
    expect(codes(findings)).not.toContain("D-003");
  });

  it("flags one that is nearly right", async () => {
    const findings = await run("xrechnung-ubl-valid-01.xml", {
      buyerReference: "04011000-1234512345-6",
    });
    expect(codes(findings)).toContain("D-003");
  });

  // BT-10 is a free buyer reference in general. Flagging every purchase order
  // number would make this rule noise, and noise is how a real finding gets
  // ignored.
  it("leaves an ordinary buyer reference alone", async () => {
    for (const reference of ["SD-2026-STROM", "Bestellung Meier", "PO 4711"]) {
      const findings = await run("xrechnung-ubl-valid-01.xml", { buyerReference: reference });
      expect(codes(findings), reference).not.toContain("D-003");
    }
  });
});

describe("D-004 VIES", () => {
  const austrian = { vatId: "ATU12345678", countryCode: "AT", name: "Alpen Handel GmbH" };

  it("does not check a domestic German VAT id", async () => {
    let called = false;
    const vies: ViesLookup = {
      check: async () => {
        called = true;
        return false;
      },
    };
    await run("xrechnung-ubl-valid-01.xml", {}, { vies });
    expect(called).toBe(false);
  });

  it("flags a VAT id VIES does not know", async () => {
    const vies: ViesLookup = { check: async () => false };
    const findings = await run("xrechnung-ubl-valid-01.xml", { seller: austrian }, { vies });
    const d004 = findings.find((f) => f.code === "D-004");
    expect(d004?.severity).toBe("content_error");
  });

  // VIES is down often enough that this is the normal path, not the edge one.
  // A tax authority outage must never tell a customer their invoice is wrong.
  it("degrades to a warning when VIES does not answer", async () => {
    const vies: ViesLookup = { check: async () => undefined };
    const findings = await run("xrechnung-ubl-valid-01.xml", { seller: austrian }, { vies });
    const d004 = findings.find((f) => f.code === "D-004");
    expect(d004?.severity).toBe("warning");
    expect(d004?.explainKey).toBe("domain.d004.vies_unavailable");
  });

  it("says nothing when the id checks out", async () => {
    const vies: ViesLookup = { check: async () => true };
    const findings = await run("xrechnung-ubl-valid-01.xml", { seller: austrian }, { vies });
    expect(codes(findings)).not.toContain("D-004");
  });
});

describe("D-005 rate and category consistency", () => {
  it("flags a zero-rated category carrying a rate", async () => {
    const findings = await run("xrechnung-ubl-valid-01.xml", {
      taxBreakdown: [{ category: "AE", rate: 19, taxAmount: 0, exemptionReason: "x" }],
    });
    expect(codes(findings)).toContain("D-005");
  });

  it("flags the standard rate at zero", async () => {
    const findings = await run("xrechnung-ubl-valid-01.xml", {
      taxBreakdown: [{ category: "S", rate: 0, taxAmount: 0 }],
    });
    const d005 = findings.find((f) => f.code === "D-005");
    expect(d005?.explainKey).toBe("domain.d005.standard_rate_zero");
  });

  it("warns about a rate that is not German", async () => {
    const findings = await run("xrechnung-ubl-valid-01.xml", {
      taxBreakdown: [{ category: "S", rate: 21, taxAmount: 1 }],
    });
    const d005 = findings.find((f) => f.code === "D-005");
    expect(d005?.severity).toBe("warning");
  });

  it("accepts 7 and 19", async () => {
    for (const rate of [7, 19]) {
      const findings = await run("xrechnung-ubl-valid-01.xml", {
        taxBreakdown: [{ category: "S", rate, taxAmount: 1 }],
      });
      expect(codes(findings), String(rate)).not.toContain("D-005");
    }
  });
});

describe("D-006 due before issue", () => {
  it("flags a due date earlier than the invoice date", async () => {
    const findings = await run("xrechnung-ubl-valid-01.xml", {
      issueDate: "2026-08-22",
      dueDate: "2026-08-01",
    });
    expect(codes(findings)).toContain("D-006");
  });

  it("accepts same-day payment terms", async () => {
    const findings = await run("xrechnung-ubl-valid-01.xml", {
      issueDate: "2026-08-22",
      dueDate: "2026-08-22",
    });
    expect(codes(findings)).not.toContain("D-006");
  });
});

describe("D-007 duplicate invoice", () => {
  const history = (seen: boolean): SupplierHistory => ({
    hasInvoiceNumber: async () => seen,
    amountStats: async () => undefined,
  });

  it("flags a number this supplier already used", async () => {
    const findings = await run("xrechnung-ubl-valid-01.xml", {}, { history: history(true) });
    const d007 = findings.find((f) => f.code === "D-007");
    expect(d007?.severity).toBe("content_error");
    expect(d007?.legalBasis).toBe("§ 14c Abs. 1 UStG");
  });

  it("says nothing the first time", async () => {
    expect(
      codes(await run("xrechnung-ubl-valid-01.xml", {}, { history: history(false) })),
    ).not.toContain("D-007");
  });

  it("does nothing without a history port", async () => {
    expect(codes(await run("xrechnung-ubl-valid-01.xml"))).not.toContain("D-007");
  });
});

describe("D-008 IBAN country mismatch", () => {
  /**
   * The invoice-fraud signal: a real supplier, a real invoice, an IBAN swapped
   * for the attacker's. A warning rather than an error, because a German
   * company banking in Luxembourg is ordinary - it asks for a phone call, it
   * does not block a payment.
   */
  it("warns when the payment account is in another country", async () => {
    const findings = await run("xrechnung-ubl-valid-01.xml", {
      payment: { iban: "LT121000011101001000" },
    });
    const d008 = findings.find((f) => f.code === "D-008");
    expect(d008?.severity).toBe("warning");
    expect(d008?.params).toMatchObject({ vat_country: "DE", iban_country: "LT" });
  });

  it("says nothing when both are German", async () => {
    expect(codes(await run("xrechnung-ubl-valid-01.xml"))).not.toContain("D-008");
  });

  it("says nothing when there is no IBAN to compare", async () => {
    expect(codes(await run("xrechnung-ubl-valid-01.xml", { payment: {} }))).not.toContain("D-008");
  });
});

describe("D-009 amount outlier", () => {
  const history = (count: number, mean: number): SupplierHistory => ({
    hasInvoiceNumber: async () => false,
    amountStats: async () => ({ count, mean }),
  });

  it("warns when an invoice is far above the supplier's average", async () => {
    const findings = await run("xrechnung-ubl-valid-01.xml", {}, { history: history(24, 100) });
    const d009 = findings.find((f) => f.code === "D-009");
    expect(d009?.severity).toBe("warning");
    expect(d009?.params).toMatchObject({ sample_size: 24 });
  });

  // Without a baseline, every new supplier's first invoice is an outlier, and
  // every relationship opens with a false fraud alert.
  it("stays quiet until there is enough history", async () => {
    expect(
      codes(await run("xrechnung-ubl-valid-01.xml", {}, { history: history(5, 100) })),
    ).not.toContain("D-009");
  });

  it("stays quiet within three times the average", async () => {
    expect(
      codes(await run("xrechnung-ubl-valid-01.xml", {}, { history: history(24, 400) })),
    ).not.toContain("D-009");
  });
});

describe("clean invoices", () => {
  it("produce no domain findings at all", async () => {
    for (const name of [
      "xrechnung-ubl-valid-01.xml",
      "xrechnung-cii-valid-01.xml",
      "zugferd-en16931-01.xml",
    ]) {
      expect(codes(await run(name)), name).toEqual([]);
    }
  });

  it("carry the versions that produced them (R-2)", async () => {
    const findings = await run("missing-exemption-reason-ae-01.xml");
    for (const f of findings) {
      expect(f.versions.validatorConfigVersion).toBe("test-config");
      expect(f.versions.engineVersion).toBe("test-engine");
    }
  });
});
