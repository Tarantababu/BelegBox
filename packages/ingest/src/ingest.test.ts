import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { generateInboxAddress, parseInboxAddress, slugify } from "./address.js";
import { hasAuthFailure, isUnauthenticated, parseAuthenticationResults } from "./auth-results.js";
import { extractEmbeddedFiles } from "./pdf.js";
import { ingestMessage } from "./pipeline.js";
import { mailgunSource } from "./sources/mailgun.js";
import { postmarkSource } from "./sources/postmark.js";
import type { InboundMessage, RawAttachment, SenderAuth } from "./types.js";

const CORPUS = join(import.meta.dirname, "../../../corpus");
const fixture = (name: string) => readFile(join(CORPUS, name));

const PASSING_AUTH: SenderAuth = { spf: "pass", dkim: "pass", dmarc: "pass" };

/**
 * Builds a PDF/A-3-shaped container with one FlateDecoded embedded file. Not a
 * conformant PDF/A-3 - just the structure the extractor has to walk.
 */
function buildPdfWithAttachment(name: string, payload: Buffer): Buffer {
  const stream = deflateSync(payload);
  const head = Buffer.from(
    `%PDF-1.7\n` +
      `1 0 obj << /Type /Catalog /Names << /EmbeddedFiles << /Names [ (${name}) 2 0 R ] >> >> >> endobj\n` +
      `2 0 obj << /Type /Filespec /F (${name}) /UF (${name}) /EF << /F 3 0 R >> >> endobj\n` +
      `3 0 obj << /Type /EmbeddedFile /Subtype /text#2Fxml /Filter /FlateDecode /Length ${stream.length} >> stream\n`,
    "latin1",
  );
  const tail = Buffer.from(
    `\nendstream endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`,
    "latin1",
  );
  return Buffer.concat([head, stream, tail]);
}

function message(attachments: RawAttachment[], over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    provider: "postmark",
    providerMessageId: "pm-1",
    to: "sahin-doener-a7f31c9d@belegbox.de",
    from: "rechnung@getraenke-mueller-beispiel.de",
    subject: "Rechnung GM-88213",
    receivedAt: new Date("2026-08-27T09:14:00Z"),
    senderAuth: PASSING_AUTH,
    attachments,
    ...over,
  };
}

const xmlAttachment = (bytes: Buffer, filename = "rechnung.xml"): RawAttachment => ({
  filename,
  contentType: "application/xml",
  bytes,
});

describe("slugify", () => {
  it("folds Turkish characters, including dotless i", () => {
    expect(slugify("Şahin Döner GmbH")).toBe("sahin-doener");
    expect(slugify("Yıldız Işık AG")).toBe("yildiz-isik");
  });

  it("folds Polish and Romanian characters", () => {
    expect(slugify("Kowalski Sp. z o.o.")).toBe("kowalski-sp-z-o-o");
    expect(slugify("Popescu Construcții GbR")).toBe("popescu-constructii");
  });

  it("strips legal forms without eating the name", () => {
    expect(slugify("Verpackungs-Service Nord GmbH & Co. KG")).toBe("verpackungs-service-nord");
    expect(slugify("Kaya Logistik UG (haftungsbeschränkt)")).toBe("kaya-logistik");
    // "KG" inside a word is not a legal form.
    expect(slugify("KGS Anlagenbau")).toBe("kgs-anlagenbau");
  });

  it("expands the German sharp s", () => {
    expect(slugify("Weißbier Handel")).toBe("weissbier-handel");
  });

  it("never returns an empty slug", () => {
    expect(slugify("!!!")).toBe("inbox");
  });
});

describe("inbox addressing", () => {
  it("round-trips a generated address", () => {
    const addr = generateInboxAddress("Şahin Döner GmbH", "belegbox.de", "a7f31c9d");
    expect(addr.address).toBe("sahin-doener-a7f31c9d@belegbox.de");
    expect(parseInboxAddress(addr.address)).toMatchObject({
      slug: "sahin-doener",
      suffix: "a7f31c9d",
    });
  });

  it("generates a random suffix by default", () => {
    const a = generateInboxAddress("Şahin Döner GmbH");
    const b = generateInboxAddress("Şahin Döner GmbH");
    expect(a.suffix).not.toBe(b.suffix);
    expect(a.suffix).toMatch(/^[0-9a-f]{8}$/);
  });

  // The entropy is the whole point: a slug-only address is guessable from a
  // company name, and anyone who guesses it can inject a forged invoice.
  it("refuses an address with no suffix", () => {
    expect(parseInboxAddress("sahin-doener@belegbox.de")).toBeNull();
    expect(parseInboxAddress("sahin-doener-XXXX@belegbox.de")).toBeNull();
  });

  it("tolerates plus-addressing from the provider", () => {
    expect(parseInboxAddress("inbound+sahin-doener-a7f31c9d@belegbox.de")).toMatchObject({
      slug: "sahin-doener",
    });
  });
});

describe("Authentication-Results", () => {
  it("parses a full pass and the signing domain", () => {
    const auth = parseAuthenticationResults(
      "mx.belegbox.de; spf=pass smtp.mailfrom=lieferant.de; dkim=pass header.d=lieferant.de; dmarc=pass",
    );
    expect(auth).toMatchObject({ spf: "pass", dkim: "pass", dmarc: "pass", dkimDomain: "lieferant.de" });
    expect(isUnauthenticated(auth)).toBe(false);
    expect(hasAuthFailure(auth)).toBe(false);
  });

  it("treats a missing header as unknown, never as pass", () => {
    const auth = parseAuthenticationResults(undefined);
    expect(auth).toMatchObject({ spf: "unknown", dkim: "unknown", dmarc: "unknown" });
    expect(isUnauthenticated(auth)).toBe(true);
  });

  it("maps unrecognised results to unknown rather than pass", () => {
    expect(parseAuthenticationResults("spf=permerror; dkim=temperror").spf).toBe("unknown");
  });

  it("flags an active failure", () => {
    expect(hasAuthFailure(parseAuthenticationResults("spf=fail; dkim=none; dmarc=fail"))).toBe(true);
  });

  it("accepts DMARC pass alone as authenticated", () => {
    expect(isUnauthenticated(parseAuthenticationResults("spf=none; dkim=none; dmarc=pass"))).toBe(false);
  });
});

describe("PDF embedded file extraction", () => {
  it("pulls the invoice XML out of a ZUGFeRD-shaped container", async () => {
    const xml = await fixture("zugferd-en16931-01.xml");
    const result = extractEmbeddedFiles(buildPdfWithAttachment("factur-x.xml", xml));

    expect(result.problem).toBeUndefined();
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.filename).toBe("factur-x.xml");
    expect(result.files[0]?.isKnownInvoiceName).toBe(true);
    expect(result.files[0]?.bytes.equals(xml)).toBe(true);
  });

  it("explains a PDF with no attachment instead of failing silently", () => {
    const plain = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n", "latin1");
    const result = extractEmbeddedFiles(plain);
    expect(result.files).toHaveLength(0);
    expect(result.problem).toMatch(/not an e-invoice/);
  });

  it("refuses an encrypted PDF with an actionable message", () => {
    const encrypted = Buffer.from("%PDF-1.7\ntrailer << /Encrypt 9 0 R >>\n%%EOF\n", "latin1");
    expect(extractEmbeddedFiles(encrypted).problem).toMatch(/encrypted/i);
  });

  it("rejects input that is not a PDF", () => {
    expect(extractEmbeddedFiles(Buffer.from("<Invoice/>")).problem).toBe("Not a PDF container.");
  });
});

describe("ingestMessage", () => {
  it("ingests an XRechnung XML attachment", async () => {
    const xml = await fixture("xrechnung-ubl-valid-01.xml");
    const out = ingestMessage(message([xmlAttachment(xml)]));

    expect(out.inboxSlug).toBe("sahin-doener");
    expect(out.documents).toHaveLength(1);

    const doc = out.documents[0];
    expect(doc?.detection?.format).toBe("xrechnung_ubl");
    expect(doc?.detection?.invoiceNumber).toBe("SWK-08-2026");
    expect(doc?.payload?.embedded).toBe(false);
    expect(doc?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(out.warnings).toHaveLength(0);
  });

  it("ingests a ZUGFeRD PDF and archives the container, not the XML", async () => {
    const xml = await fixture("zugferd-en16931-01.xml");
    const pdf = buildPdfWithAttachment("factur-x.xml", xml);
    const out = ingestMessage(
      message([{ filename: "RE-3390.pdf", contentType: "application/pdf", bytes: pdf }]),
    );

    expect(out.documents).toHaveLength(1);
    const doc = out.documents[0];
    // GoBD keeps the original. For a hybrid invoice the original is the PDF.
    expect(doc?.bytes.equals(pdf)).toBe(true);
    expect(doc?.filename).toBe("RE-3390.pdf");
    // The XML inside is what gets validated.
    expect(doc?.payload?.embedded).toBe(true);
    expect(doc?.payload?.filename).toBe("factur-x.xml");
    expect(doc?.detection?.format).toBe("zugferd");
    expect(doc?.detection?.profile.legalClass).toBe("einvoice");
  });

  it("classifies an embedded MINIMUM profile as not an e-invoice", async () => {
    const xml = await fixture("zugferd-minimum-01.xml");
    const pdf = buildPdfWithAttachment("factur-x.xml", xml);
    const out = ingestMessage(
      message([{ filename: "WU-77120.pdf", contentType: "application/pdf", bytes: pdf }]),
    );

    // D-001. The supplier believes this is compliant; it carries no line data.
    expect(out.documents[0]?.detection?.profile.legalClass).toBe("not_einvoice");
    expect(out.documents[0]?.detection?.profile.name).toContain("MINIMUM");
  });

  it("stores a plain PDF rather than discarding it", () => {
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n", "latin1");
    const out = ingestMessage(
      message([{ filename: "scan.pdf", contentType: "application/pdf", bytes: pdf }]),
    );

    // § 14b UStG still requires keeping it, so it is a document with no payload.
    expect(out.documents).toHaveLength(1);
    expect(out.documents[0]?.payload).toBeUndefined();
    expect(out.documents[0]?.detectionError?.code).toBe("no_payload");
    expect(out.warnings.map((w) => w.code)).toContain("pdf_extraction_failed");
    expect(out.warnings.map((w) => w.code)).toContain("no_einvoice_found");
  });

  it("rejects attachments that are neither XML nor PDF", async () => {
    const xml = await fixture("xrechnung-ubl-valid-01.xml");
    const out = ingestMessage(
      message([
        xmlAttachment(xml),
        { filename: "logo.png", contentType: "image/png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      ]),
    );

    expect(out.documents).toHaveLength(1);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0]?.filename).toBe("logo.png");
  });

  it("sniffs content rather than trusting the declared type", async () => {
    const xml = await fixture("xrechnung-cii-valid-01.xml");
    const out = ingestMessage(
      message([{ filename: "invoice.txt", contentType: "application/octet-stream", bytes: xml }]),
    );
    expect(out.documents[0]?.detection?.format).toBe("xrechnung_cii");
  });

  it("collapses the same file attached twice", async () => {
    const xml = await fixture("xrechnung-ubl-valid-01.xml");
    const out = ingestMessage(message([xmlAttachment(xml, "a.xml"), xmlAttachment(xml, "b.xml")]));
    expect(out.documents).toHaveLength(1);
  });

  it("warns about an oversized attachment without throwing", async () => {
    const xml = await fixture("xrechnung-ubl-valid-01.xml");
    const out = ingestMessage(message([xmlAttachment(xml)]), { maxAttachmentBytes: 10 });
    expect(out.documents).toHaveLength(0);
    expect(out.warnings.map((w) => w.code)).toContain("attachment_too_large");
  });

  // Warn, never block: a supplier with a broken SPF record still sends real
  // invoices, and a silently dropped invoice is worse than a flagged one.
  it("warns on a failed sender check but still ingests", async () => {
    const xml = await fixture("xrechnung-ubl-valid-01.xml");
    const out = ingestMessage(
      message([xmlAttachment(xml)], {
        senderAuth: { spf: "fail", dkim: "none", dmarc: "fail" },
      }),
    );
    expect(out.documents).toHaveLength(1);
    expect(out.warnings.map((w) => w.code)).toContain("sender_auth_failed");
  });

  it("flags an unroutable recipient", async () => {
    const xml = await fixture("xrechnung-ubl-valid-01.xml");
    const out = ingestMessage(message([xmlAttachment(xml)], { to: "hello@belegbox.de" }));
    expect(out.inboxSlug).toBeUndefined();
    expect(out.warnings.map((w) => w.code)).toContain("unroutable_recipient");
  });

  it("survives a message with no attachments", () => {
    const out = ingestMessage(message([]));
    expect(out.documents).toHaveLength(0);
    expect(out.warnings.map((w) => w.code)).toContain("no_einvoice_found");
  });
});

describe("postmark source", () => {
  const source = postmarkSource({ webhookUser: "hook", webhookPassword: "s3cret-value" });
  const basic = (u: string, p: string) =>
    `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;

  it("accepts correct credentials", () => {
    expect(source.verify({ authorization: basic("hook", "s3cret-value"), payload: {} })).toEqual({
      ok: true,
    });
  });

  it("rejects wrong credentials, a missing header and a wrong scheme", () => {
    expect(source.verify({ authorization: basic("hook", "wrong"), payload: {} }).ok).toBe(false);
    expect(source.verify({ payload: {} }).ok).toBe(false);
    expect(source.verify({ authorization: "Bearer abc", payload: {} }).ok).toBe(false);
  });

  it("refuses to construct without a secret", () => {
    expect(() => postmarkSource({ webhookUser: "", webhookPassword: "" })).toThrow();
  });

  it("normalises a payload and prefers the envelope recipient", async () => {
    const xml = await fixture("xrechnung-ubl-valid-01.xml");
    const msg = source.normalize({
      authorization: basic("hook", "s3cret-value"),
      payload: {
        MessageID: "pm-abc",
        Date: "Thu, 27 Aug 2026 09:14:00 +0200",
        From: "rechnung@lieferant.de",
        Subject: "Rechnung",
        // `To` is sender-controlled; OriginalRecipient is the envelope.
        To: "buchhaltung@example.com",
        OriginalRecipient: "sahin-doner-a7f31c9d@belegbox.de",
        Headers: [
          { Name: "Message-ID", Value: "<abc@lieferant.de>" },
          { Name: "Authentication-Results", Value: "spf=pass; dkim=pass; dmarc=pass" },
        ],
        Attachments: [
          {
            Name: "rechnung.xml",
            ContentType: "application/xml",
            Content: xml.toString("base64"),
          },
        ],
      },
    });

    expect(msg.to).toBe("sahin-doner-a7f31c9d@belegbox.de");
    expect(msg.messageId).toBe("<abc@lieferant.de>");
    expect(msg.senderAuth.dmarc).toBe("pass");
    expect(msg.attachments[0]?.bytes.equals(xml)).toBe(true);
    expect(ingestMessage(msg).documents[0]?.detection?.format).toBe("xrechnung_ubl");
  });

  it("tolerates an empty payload", () => {
    const msg = source.normalize({ payload: {} });
    expect(msg.to).toBe("");
    expect(msg.attachments).toHaveLength(0);
  });
});

describe("mailgun source", () => {
  const signingKey = "key-test-signing";
  const sign = (timestamp: string, token: string) =>
    createHmac("sha256", signingKey).update(timestamp + token).digest("hex");

  const fields = (over: Record<string, string> = {}) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const token = `tok-${Math.random().toString(16).slice(2)}`;
    return {
      timestamp,
      token,
      signature: sign(timestamp, token),
      recipient: "sahin-doner-a7f31c9d@belegbox.de",
      sender: "rechnung@lieferant.de",
      subject: "Rechnung",
      "message-headers": JSON.stringify([
        ["Authentication-Results", "spf=pass; dkim=pass; dmarc=pass"],
      ]),
      ...over,
    };
  };

  it("accepts a valid signature", () => {
    const source = mailgunSource({ signingKey });
    expect(source.verify({ fields: fields(), attachments: [] })).toEqual({ ok: true });
  });

  it("rejects a forged signature", () => {
    const source = mailgunSource({ signingKey });
    expect(source.verify({ fields: fields({ signature: "00".repeat(32) }), attachments: [] }).ok).toBe(
      false,
    );
  });

  it("rejects a signature outside the tolerance window", () => {
    const source = mailgunSource({ signingKey });
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    const token = "tok-old";
    const result = source.verify({
      fields: fields({ timestamp: old, token, signature: sign(old, token) }),
      attachments: [],
    });
    expect(result).toMatchObject({ ok: false });
  });

  // A valid signature captured off the wire is still an attack if it replays.
  it("rejects a replayed token", () => {
    const source = mailgunSource({ signingKey });
    const f = fields();
    expect(source.verify({ fields: f, attachments: [] }).ok).toBe(true);
    const second = source.verify({ fields: f, attachments: [] });
    expect(second).toMatchObject({ ok: false });
    if (!second.ok) expect(second.reason).toMatch(/replay/i);
  });

  it("normalises fields and survives malformed message-headers", async () => {
    const source = mailgunSource({ signingKey });
    const xml = await fixture("xrechnung-cii-valid-01.xml");
    const msg = source.normalize({
      fields: fields({ "message-headers": "{not json" }),
      attachments: [{ filename: "re.xml", contentType: "application/xml", bytes: xml }],
    });
    expect(msg.to).toBe("sahin-doner-a7f31c9d@belegbox.de");
    expect(msg.senderAuth.spf).toBe("unknown");
    expect(ingestMessage(msg).documents[0]?.detection?.format).toBe("xrechnung_cii");
  });

  it("refuses to construct without a signing key", () => {
    expect(() => mailgunSource({ signingKey: "" })).toThrow();
  });
});
