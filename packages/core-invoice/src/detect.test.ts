import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detect } from "./detect.js";
import { classifyProfile, xrechnungVersion } from "./profiles.js";
import { DetectionError } from "./types.js";

const CORPUS = join(import.meta.dirname, "../../../corpus");
const fixture = (name: string) => readFile(join(CORPUS, name));

describe("classifyProfile", () => {
  // D-001. These two are the rule no competing product implements.
  it("treats ZUGFeRD MINIMUM as not an e-invoice", () => {
    const p = classifyProfile("urn:factur-x.eu:1p0:minimum");
    expect(p.legalClass).toBe("not_einvoice");
    expect(p.name).toContain("MINIMUM");
  });

  it("treats ZUGFeRD BASIC WL as not an e-invoice", () => {
    expect(classifyProfile("urn:factur-x.eu:1p0:basicwl").legalClass).toBe(
      "not_einvoice",
    );
  });

  it("treats ZUGFeRD BASIC as an e-invoice", () => {
    expect(classifyProfile("urn:factur-x.eu:1p0:basic").legalClass).toBe("einvoice");
  });

  it("does not confuse BASIC WL with BASIC", () => {
    expect(classifyProfile("urn:factur-x.eu:1p0:basicwl").name).not.toContain(
      "BASIC WL BASIC",
    );
    expect(classifyProfile("urn:factur-x.eu:1p0:basic").name).toContain("BASIC");
  });

  it("recognises XRechnung and extracts the CIUS version", () => {
    const p = classifyProfile(
      "urn:cen.eu:en16931:2017#compliant#urn:xoev-de:kosit:standard:xrechnung_3.0",
    );
    expect(p).toMatchObject({ legalClass: "einvoice", cius: "xrechnung" });
    expect(p.name).toBe("XRechnung 3.0");
  });

  it("is case-insensitive on the URN", () => {
    expect(classifyProfile("URN:FACTUR-X.EU:1P0:MINIMUM").legalClass).toBe(
      "not_einvoice",
    );
  });

  // An unknown profile must reach a human rather than pass silently.
  it("refuses to vouch for an unrecognised profile", () => {
    expect(classifyProfile("urn:example:something:else").legalClass).toBe(
      "not_einvoice",
    );
  });

  it("reads the version out of a customization URN", () => {
    expect(xrechnungVersion("...xrechnung_3.0")).toBe("3.0");
    expect(xrechnungVersion("urn:cen.eu:en16931:2017")).toBeUndefined();
  });
});

describe("detect", () => {
  it("reads an XRechnung UBL invoice", async () => {
    const r = detect(await fixture("xrechnung-ubl-valid-01.xml"));
    expect(r).toMatchObject({
      syntax: "ubl",
      format: "xrechnung_ubl",
      rootElement: "Invoice",
      invoiceNumber: "SWK-08-2026",
      issueDate: "2026-08-22",
      documentTypeCode: "380",
    });
    expect(r.profile.legalClass).toBe("einvoice");
  });

  it("reads an XRechnung CII invoice and normalises the 102 date", async () => {
    const r = detect(await fixture("xrechnung-cii-valid-01.xml"));
    expect(r).toMatchObject({
      syntax: "cii",
      format: "xrechnung_cii",
      rootElement: "CrossIndustryInvoice",
      invoiceNumber: "RE-2026-4471",
      issueDate: "2026-08-28",
    });
  });

  it("flags a ZUGFeRD MINIMUM document as not an e-invoice", async () => {
    const r = detect(await fixture("zugferd-minimum-01.xml"));
    expect(r.format).toBe("zugferd");
    expect(r.profile.legalClass).toBe("not_einvoice");
  });

  it("accepts ZUGFeRD EN 16931", async () => {
    const r = detect(await fixture("zugferd-en16931-01.xml"));
    expect(r.format).toBe("zugferd");
    expect(r.profile.legalClass).toBe("einvoice");
  });

  it("rejects a PDF container with an actionable message", () => {
    const err = (() => {
      try {
        detect(Buffer.from("%PDF-1.7\n..."));
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(DetectionError);
    expect((err as DetectionError).code).toBe("pdf_container");
  });

  it("rejects XML with an unknown root element", () => {
    expect(() => detect("<Order><ID>1</ID></Order>")).toThrowError(DetectionError);
  });

  it("rejects an invoice with no CustomizationID", () => {
    const xml =
      '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><ID>1</ID></Invoice>';
    try {
      detect(xml);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as DetectionError).code).toBe("missing_profile");
    }
  });
});
