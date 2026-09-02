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



  /**
   * ZUGFeRD 2.0 also identifies itself in its own namespace, and every one of
   * these is in the official ZUGFeRD corpus. Matching on the vendor rather than
   * on the conformance level meant `urn:zugferd.de:2p0:minimum` matched no rule
   * at all - and the unknown branch answers not_einvoice, so the verdict was
   * right by accident while D-001 never fired.
   */
  it("applies D-001 to ZUGFeRD's own namespace, not just Factur-X's", () => {
    const p = classifyProfile("urn:zugferd.de:2p0:minimum");
    expect(p.legalClass).toBe("not_einvoice");
    expect(p.name).toContain("MINIMUM");
  });

  it("does not mark ZUGFeRD 2.0 BASIC as not an e-invoice", () => {
    // The same hole, in the direction that loses a real invoice.
    const p = classifyProfile("urn:cen.eu:en16931:2017#compliant#urn:zugferd.de:2p0:basic");
    expect(p.legalClass).toBe("einvoice");
    expect(p.name).toContain("BASIC");
  });

  it("reads the level out of an EN 16931 refinement URN", () => {
    expect(
      classifyProfile("urn:cen.eu:en16931:2017#conformant#urn:zugferd.de:2p0:extended").name,
    ).toContain("EXTENDED");
    // Colon-separated, as Factur-X BASIC writes it in the corpus.
    expect(
      classifyProfile("urn:cen.eu:en16931:2017:compliant:factur-x.eu:1p0:basic").name,
    ).toContain("BASIC");
  });

  it("names Peppol BIS even though its URN begins with the EN 16931 one", () => {
    const p = classifyProfile(
      "urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0",
    );
    expect(p).toMatchObject({ legalClass: "einvoice", cius: "peppol-bis" });
    expect(p.name).toBe("Peppol BIS Billing 3.0");
  });

  it("refuses to guess when the ZUGFeRD conformance level is unknown", () => {
    // Knowing the family without the level says nothing about line-level data,
    // and "e-invoice" is the unsafe direction to guess in.
    expect(classifyProfile("urn:factur-x.eu:9p9:brandnew").legalClass).toBe("not_einvoice");
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

  /**
   * ZUGFeRD 1.0 is a real invoice and not an e-invoice, and saying which is the
   * useful answer. Two shapes: <rsm:CrossIndustryDocument> in the final
   * namespace, and <rsm:Invoice> in the release-candidate one - the second of
   * which was read as UBL, because with namespace prefixes stripped it is
   * spelled exactly like a UBL Invoice.
   */
  it("names ZUGFeRD 1.0 rather than calling it an unknown root", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <rsm:CrossIndustryDocument
        xmlns:rsm="urn:ferd:CrossIndustryDocument:invoice:1p0"/>`;
    expect(() => detect(xml)).toThrow(DetectionError);
    try {
      detect(xml);
    } catch (err) {
      expect((err as DetectionError).code).toBe("zugferd_v1");
      expect((err as DetectionError).message).toContain("EN 16931");
    }
  });

  it("does not mistake a ZUGFeRD 1.0 RC <Invoice> for UBL", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <rsm:Invoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CBFBUY:5"/>`;
    try {
      detect(xml);
      throw new Error("expected a DetectionError");
    } catch (err) {
      // Previously: "Missing cbc:CustomizationID", a complaint about a UBL
      // field on a document that was never UBL.
      expect((err as DetectionError).code).toBe("zugferd_v1");
    }
  });

  it("names fatturaPA instead of rejecting it as an unknown root", () => {
    const xml = `<?xml version="1.0"?>
      <p:FatturaElettronica xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2"
        versione="FPA12"/>`;
    try {
      detect(xml);
      throw new Error("expected a DetectionError");
    } catch (err) {
      expect((err as DetectionError).code).toBe("foreign_format");
      expect((err as DetectionError).message).toContain("fatturaPA");
    }
  });

  it("names the namespace when an <Invoice> is not UBL", () => {
    const xml = `<Invoice xmlns="urn:example:something-else"/>`;
    try {
      detect(xml);
      throw new Error("expected a DetectionError");
    } catch (err) {
      expect((err as DetectionError).code).toBe("unknown_root");
      expect((err as DetectionError).message).toContain("urn:example:something-else");
    }
  });

  it("still treats an <Invoice> with no namespace as UBL", () => {
    const xml = `<Invoice><CustomizationID>urn:cen.eu:en16931:2017</CustomizationID></Invoice>`;
    expect(detect(xml).syntax).toBe("ubl");
  });

  it("does not file plain EN 16931 UBL under Peppol", () => {
    // BT-23 ProfileID names the business process. Mustangproject's CII-to-UBL
    // conversion writes a Peppol one onto plain EN 16931 documents, and reading
    // it put them under a CIUS they do not follow.
    const xml = `<Invoice>
      <CustomizationID>urn:cen.eu:en16931:2017</CustomizationID>
      <ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</ProfileID>
    </Invoice>`;
    const d = detect(xml);
    expect(d.format).toBe("en16931_ubl");
    expect(d.profile.name).toBe("EN 16931 (COMFORT)");
  });
});
