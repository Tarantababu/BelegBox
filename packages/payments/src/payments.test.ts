import jsQR from "jsqr";
import QRCode from "qrcode";
import { describe, expect, it } from "vitest";
import {
  GiroCodeError,
  buildGiroCodePayload,
  payloadByteLength,
  EPC_MAX_BYTES,
} from "./girocode.js";
import { formatIban, isValidBic, isValidIban, normalizeIban } from "./iban.js";
import { renderGiroCodeSvg } from "./qr.js";
import { SepaError, buildSepaFile, sepaFilename } from "./sepa.js";

/** Published test IBANs with valid check digits. */
const IBAN = "DE02120300000000202051";
const IBAN_2 = "DE02100500000054540402";

const base = {
  beneficiaryName: "Getränke Müller GmbH",
  iban: IBAN,
  amount: 428.4,
  remittance: "GM-88213",
};

describe("IBAN", () => {
  it("accepts valid IBANs and rejects a single altered digit", () => {
    expect(isValidIban(IBAN)).toBe(true);
    expect(isValidIban("DE02120300000000202052")).toBe(false);
  });

  it("ignores spacing and case", () => {
    expect(isValidIban("de02 1203 0000 0000 2020 51")).toBe(true);
    expect(normalizeIban("de02 1203")).toBe("DE021203");
    expect(formatIban(IBAN)).toBe("DE02 1203 0000 0000 2020 51");
  });

  /**
   * A 34-character IBAN expands past what a JavaScript number holds exactly.
   * Computed as one big integer, the precision loss makes some invalid IBANs
   * pass - which is why the checksum runs digit by digit.
   */
  it("handles the longest IBANs without precision loss", () => {
    const maltese = "MT84MALT011000012345MTLCAST001S";
    expect(isValidIban(maltese)).toBe(true);
    expect(isValidIban(maltese.slice(0, -1) + "T")).toBe(false);
  });

  it("rejects malformed input rather than throwing", () => {
    for (const bad of ["", "DE", "XX00", "DE02 1203 !!!!", "1234567890123456"]) {
      expect(isValidIban(bad), bad).toBe(false);
    }
  });

  it("validates BICs of both lengths", () => {
    expect(isValidBic("GENODEF1M04")).toBe(true);
    expect(isValidBic("COBADEFF")).toBe(true);
    expect(isValidBic("TOOSHORT1")).toBe(false);
  });
});

describe("GiroCode payload", () => {
  it("emits the twelve EPC elements in order", () => {
    const lines = buildGiroCodePayload({ ...base, bic: "GENODEF1M04" }).split("\n");
    expect(lines.slice(0, 4)).toEqual(["BCD", "002", "1", "SCT"]);
    expect(lines[4]).toBe("GENODEF1M04");
    expect(lines[5]).toBe("Getränke Müller GmbH");
    expect(lines[6]).toBe(IBAN);
    expect(lines[7]).toBe("EUR428.40");
    expect(lines[8]).toBe(""); // purpose
    expect(lines[9]).toBe(""); // structured reference
    expect(lines[10]).toBe("GM-88213");
  });

  it("omits the BIC, which version 002 allows inside the EEA", () => {
    expect(buildGiroCodePayload(base).split("\n")[4]).toBe("");
  });

  it("formats the amount with a dot and two decimals", () => {
    expect(buildGiroCodePayload({ ...base, amount: 5 }).split("\n")[7]).toBe("EUR5.00");
    expect(buildGiroCodePayload({ ...base, amount: 0.015 }).split("\n")[7]).toBe("EUR0.02");
  });

  it("refuses amounts outside the EPC range", () => {
    expect(() => buildGiroCodePayload({ ...base, amount: 0 })).toThrow(/at least 0.01/);
    expect(() => buildGiroCodePayload({ ...base, amount: 1e10 })).toThrow(/at most/);
    expect(() => buildGiroCodePayload({ ...base, amount: Number.NaN })).toThrow(GiroCodeError);
  });

  // The prototype never truncated, so a long legal name produced a payload no
  // app would parse.
  it("truncates the beneficiary name at 70 characters", () => {
    const long = "Verpackungs-Service Nord Handelsgesellschaft mit beschraenkter Haftung und Co. KG";
    expect(long.length).toBeGreaterThan(70);
    expect(buildGiroCodePayload({ ...base, beneficiaryName: long }).split("\n")[5]).toHaveLength(70);
  });

  /**
   * Newlines separate the elements, so one inside a supplier name would shift
   * every field after it - the amount read as the IBAN. Supplier names arrive
   * by email from anyone who learns the inbox address.
   */
  it("keeps an injected newline inside the name element", () => {
    const payload = buildGiroCodePayload({
      ...base,
      beneficiaryName: "Evil GmbH\nDE89370400440532013000\nEUR9999.00",
    });
    const lines = payload.split("\n");

    // The injected text is flattened into the name rather than becoming
    // elements of its own, so the fields after it are untouched. That, not the
    // absence of the string, is the property that matters.
    expect(lines).toHaveLength(11);
    expect(lines[5]).toBe("Evil GmbH DE89370400440532013000 EUR9999.00");
    expect(lines[6]).toBe(IBAN);
    expect(lines[7]).toBe("EUR428.40");
  });

  it("refuses an invalid IBAN rather than encoding it", () => {
    expect(() => buildGiroCodePayload({ ...base, iban: "DE02120300000000202052" })).toThrow(
      /not a valid IBAN/,
    );
  });

  it("refuses a structured reference and free text together", () => {
    expect(() =>
      buildGiroCodePayload({ ...base, structuredReference: "RF18539007547034" }),
    ).toThrow(/never both/);
  });

  it("stays inside the 331-byte ceiling and says so when it cannot", () => {
    expect(payloadByteLength(buildGiroCodePayload(base))).toBeLessThanOrEqual(EPC_MAX_BYTES);
    expect(() =>
      buildGiroCodePayload({ ...base, remittance: "x".repeat(139), information: "y".repeat(70) }),
    ).not.toThrow();
  });
});

describe("GiroCode rendering", () => {
  /**
   * The prototype's QR was a deterministic pattern with three finder squares:
   * convincing on screen, unscannable. Decoding it back is the only assertion
   * that would have caught that.
   */
  it("produces a QR code that decodes to the payload", async () => {
    const { payload } = await renderGiroCodeSvg({ ...base, bic: "GENODEF1M04" });

    // jsQR needs pixels, so render the same payload to a raw bitmap.
    const size = 512;
    const png = await QRCode.toBuffer(payload, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: size,
      type: "png",
    });
    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");

    const matrix = QRCode.create(payload, { errorCorrectionLevel: "M" });
    const dim = matrix.modules.size;
    const scale = 4;
    const pixels = new Uint8ClampedArray(dim * scale * dim * scale * 4);
    for (let y = 0; y < dim * scale; y += 1) {
      for (let x = 0; x < dim * scale; x += 1) {
        const dark = matrix.modules.get(Math.floor(x / scale), Math.floor(y / scale));
        const value = dark ? 0 : 255;
        const offset = (y * dim * scale + x) * 4;
        pixels[offset] = value;
        pixels[offset + 1] = value;
        pixels[offset + 2] = value;
        pixels[offset + 3] = 255;
      }
    }

    const decoded = jsQR(pixels, dim * scale, dim * scale);
    expect(decoded?.data).toBe(payload);
  });

  it("renders SVG carrying the payload and its size", async () => {
    const rendered = await renderGiroCodeSvg(base);
    expect(rendered.svg).toContain("<svg");
    expect(rendered.payload.startsWith("BCD\n002\n1\nSCT")).toBe(true);
    expect(rendered.byteLength).toBe(payloadByteLength(rendered.payload));
  });
});

describe("SEPA file", () => {
  const debtor = { name: "Şahin Döner GmbH", iban: IBAN_2 };
  const transfer = {
    endToEndId: "GM-88213",
    creditorName: "Getränke Müller GmbH",
    creditorIban: IBAN,
    amount: 428.4,
    remittance: "Rechnung GM-88213",
  };

  const file = (over = {}) =>
    buildSepaFile({
      debtor,
      transfers: [transfer],
      createdAt: new Date("2026-09-01T10:00:00Z"),
      requestedExecutionDate: "2026-09-10",
      messageId: "BB-TEST-1",
      ...over,
    });

  it("produces well-formed pain.001.001.03 by default", () => {
    const xml = file();
    expect(xml).toContain('xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"');
    expect(xml).toContain("<ReqdExctnDt>2026-09-10</ReqdExctnDt>");
    expect(xml).toContain("<PmtMtd>TRF</PmtMtd>");
    expect(xml).toContain("<ChrgBr>SLEV</ChrgBr>");
  });

  /**
   * The PRD names .09, and many German portals still take only .03. A file the
   * user's bank rejects is not a smaller failure than no file.
   */
  it("produces pain.001.001.09 with its wrapped date and BICFI", () => {
    const xml = file({ version: "pain.001.001.09" });
    expect(xml).toContain("pain.001.001.09");
    expect(xml).toContain("<ReqdExctnDt><Dt>2026-09-10</Dt></ReqdExctnDt>");
    expect(
      buildSepaFile({
        debtor: { ...debtor, bic: "COBADEFF" },
        transfers: [transfer],
        version: "pain.001.001.09",
      }),
    ).toContain("<BICFI>COBADEFF</BICFI>");
  });

  it("uses BIC in .03 and NOTPROVIDED when none is known", () => {
    expect(buildSepaFile({ debtor: { ...debtor, bic: "COBADEFF" }, transfers: [transfer] }))
      .toContain("<BIC>COBADEFF</BIC>");
    // The SEPA convention for "derive it from the IBAN", which every bank does.
    expect(file()).toContain("<Othr><Id>NOTPROVIDED</Id></Othr>");
  });

  it("computes the control sum from the transfers", () => {
    const xml = buildSepaFile({
      debtor,
      transfers: [transfer, { ...transfer, endToEndId: "SWK-2", amount: 71.6 }],
    });
    // A CtrlSum that disagrees with the instructions is one of the few errors a
    // bank rejects the whole batch for.
    expect(xml).toContain("<NbOfTxs>2</NbOfTxs>");
    expect(xml).toContain("<CtrlSum>500.00</CtrlSum>");
  });

  /**
   * Two layers, and the outer one gets there first: the SEPA charset filter
   * removes angle brackets and ampersands before the XML escaper ever sees
   * them, so nothing needs escaping in practice. The escaper stays because it
   * is what holds if the charset rules are ever loosened.
   */
  it("neutralises XML from an attacker-supplied creditor name", () => {
    const xml = buildSepaFile({
      debtor,
      transfers: [{ ...transfer, creditorName: 'Evil <Cdtr> & "Co"' }],
    });
    expect(xml).toContain("<Cdtr><Nm>Evil Cdtr Co</Nm></Cdtr>");
    // One creditor element, not the two an injection would have produced.
    expect(xml.match(/<Cdtr>/g)).toHaveLength(1);
  });

  it("escapes anything the charset filter would let through", () => {
    // Reached through the remittance path, which permits an apostrophe.
    const xml = buildSepaFile({
      debtor,
      transfers: [{ ...transfer, remittance: "O'Brien Rechnung" }],
    });
    expect(xml).toContain("O&apos;Brien");
  });

  /** SEPA restricts names to a Latin subset; banks mangle or reject the rest. */
  it("transliterates umlauts rather than dropping them", () => {
    const xml = file();
    expect(xml).toContain("Getraenke Mueller GmbH");
    expect(xml).toContain("Sahin Doener GmbH");
  });

  it("refuses invalid account details and empty batches", () => {
    expect(() => buildSepaFile({ debtor, transfers: [] })).toThrow(/at least one transfer/);
    expect(() =>
      buildSepaFile({ debtor: { ...debtor, iban: "DE00" }, transfers: [transfer] }),
    ).toThrow(/Debtor IBAN/);
    expect(() =>
      buildSepaFile({ debtor, transfers: [{ ...transfer, creditorIban: "DE00" }] }),
    ).toThrow(/creditor IBAN/);
    expect(() =>
      buildSepaFile({ debtor, transfers: [{ ...transfer, amount: 0 }] }),
    ).toThrow(SepaError);
  });

  it("names the file after its version and date", () => {
    expect(sepaFilename("pain.001.001.09", new Date("2026-09-01T10:00:00Z"))).toBe(
      "belegbox-sepa-pain00100109-2026-09-01.xml",
    );
  });
});
