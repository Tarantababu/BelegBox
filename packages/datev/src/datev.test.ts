import { describe, expect, it } from "vitest";
import { SKR03, SKR04, chartFor, chooseAccounts } from "./accounts.js";
import { canEncodeCp1252, encodeCp1252 } from "./cp1252.js";
import {
  COLUMNS,
  DatevError,
  HEADER_FIELDS,
  buildBuchungsstapel,
  datevFilename,
  type DatevBooking,
  type DatevExportOptions,
} from "./extf.js";

const options: DatevExportOptions = {
  beraterNumber: 1234567,
  mandantNumber: 42,
  fiscalYearStart: new Date("2026-01-01T00:00:00Z"),
  periodFrom: new Date("2026-08-01T00:00:00Z"),
  periodTo: new Date("2026-08-31T00:00:00Z"),
  accounts: SKR03,
  createdAt: new Date("2026-09-01T10:00:00Z"),
};

const booking: DatevBooking = {
  grossAmount: 428.4,
  debitCredit: "S",
  documentDate: new Date("2026-08-27T00:00:00Z"),
  invoiceNumber: "GM-88213",
  text: "Getränke Müller GmbH",
  vatCategory: "S",
  vatRate: 7,
};

const lines = (bookings = [booking], over: Partial<DatevExportOptions> = {}) =>
  buildBuchungsstapel(bookings, { ...options, ...over }).toString("latin1").split("\r\n");

describe("Windows-1252", () => {
  /**
   * DATEV specifies ANSI. Importing UTF-8 bytes turns every umlaut into
   * mojibake in a ledger that is kept for ten years.
   */
  it("encodes German umlauts as single bytes", () => {
    expect([...encodeCp1252("Getränke Müller")]).toContain(0xe4); // ä
    expect([...encodeCp1252("Getränke Müller")]).toContain(0xfc); // ü
    expect(encodeCp1252("Weiß")).toHaveLength(4);
  });

  it("encodes the euro sign from the 0x80 block", () => {
    expect([...encodeCp1252("€")]).toEqual([0x80]);
  });

  /** Turkish and Polish names are ordinary in this customer base. */
  it("transliterates what Windows-1252 cannot hold", () => {
    expect(encodeCp1252("Şahin Döner").toString("latin1")).toBe("Sahin Döner");
    expect(encodeCp1252("Yılmaz").toString("latin1")).toBe("Yilmaz");
    expect(encodeCp1252("Kowalski Łódź").toString("latin1")).toBe("Kowalski Lódz");
  });

  it("marks anything untranslatable rather than dropping it", () => {
    // A bookkeeper seeing a question mark knows something was lost; a silently
    // shortened name cannot be told from the supplier's real one.
    expect(encodeCp1252("Firma 東京").toString("latin1")).toBe("Firma ??");
  });

  it("reports what it can encode without loss", () => {
    expect(canEncodeCp1252("Getränke Müller GmbH")).toBe(true);
    expect(canEncodeCp1252("Yılmaz")).toBe(false);
  });
});

describe("account mapping", () => {
  it("books by VAT rate on the selected chart", () => {
    expect(chooseAccounts(SKR03, { vatRate: 19 }).account).toBe("3400");
    expect(chooseAccounts(SKR03, { vatRate: 7 }).account).toBe("3300");
    // A tenant on SKR04 given SKR03 numbers produces a stapel their
    // Steuerberater has to unpick line by line.
    expect(chooseAccounts(SKR04, { vatRate: 19 }).account).toBe("5400");
    expect(chooseAccounts(SKR04, { vatRate: 7 }).account).toBe("5300");
  });

  /**
   * Category before rate: a reverse-charge invoice booked as an ordinary
   * expense claims input tax that was never charged.
   */
  it("lets the VAT category override the rate", () => {
    const reverse = chooseAccounts(SKR03, { vatCategory: "AE", vatRate: 0 });
    expect(reverse.account).toBe(SKR03.reverseCharge);
    expect(reverse.bookingKey).toBe("94");

    expect(chooseAccounts(SKR03, { vatCategory: "K" }).bookingKey).toBe("91");
    expect(chooseAccounts(SKR03, { vatCategory: "E" }).account).toBe(SKR03.exempt);
  });

  it("falls back rather than inventing an account", () => {
    expect(chooseAccounts(SKR03, { vatRate: 11 }).account).toBe(SKR03.expenseDefault);
    expect(chartFor("skr04").chart).toBe("SKR04");
    expect(chartFor(null).chart).toBe("SKR03");
  });
});

describe("EXTF Buchungsstapel", () => {
  /**
   * The prototype emitted one header line of five columns. DATEV needs the EXTF
   * header, then the captions, then rows at the caption width - and it rejects
   * the whole file, not the row, when a width disagrees.
   */
  it("writes the header, the captions and rows at one width", () => {
    const out = lines();
    expect(out[0]?.split(";")).toHaveLength(HEADER_FIELDS);
    expect(out[1]?.split(";")).toHaveLength(COLUMNS.length);
    expect(out[2]?.split(";")).toHaveLength(COLUMNS.length);
    expect(out[0]?.startsWith('"EXTF";700;21;"Buchungsstapel";13;')).toBe(true);
  });

  it("names the consultant, client, fiscal year and period", () => {
    const header = lines()[0]?.split(";") ?? [];
    expect(header[10]).toBe("1234567"); // Berater
    expect(header[11]).toBe("42"); // Mandant
    expect(header[12]).toBe("20260101"); // WJ-Beginn
    expect(header[14]).toBe("20260801");
    expect(header[15]).toBe("20260831");
  });

  /** GoBD wants postings locked; DATEV treats an unlocked import as provisional. */
  it("sets Festschreibung by default and can be told not to", () => {
    expect(lines()[0]?.split(";")[20]).toBe("1");
    expect(lines([booking], { locked: false })[0]?.split(";")[20]).toBe("0");
  });

  /**
   * Belegdatum is four characters. The prototype wrote 28082026 into it, which
   * overflows the field and fails the import.
   */
  it("writes Belegdatum as DDMM", () => {
    expect(lines()[2]?.split(";")[9]).toBe("2708");
  });

  it("writes amounts with a comma and the sign in the S/H flag", () => {
    const row = lines()[2]?.split(";") ?? [];
    expect(row[0]).toBe("428,40");
    expect(row[1]).toBe('"S"');
    // A credit is the same positive amount with the other flag.
    const credit = lines([{ ...booking, debitCredit: "H", grossAmount: -428.4 }])[2]?.split(";");
    expect(credit?.[0]).toBe("428,40");
    expect(credit?.[1]).toBe('"H"');
  });

  it("puts the invoice number in Belegfeld 1 and the supplier in Buchungstext", () => {
    const row = lines()[2]?.split(";") ?? [];
    expect(row[10]).toBe('"GM-88213"');
    expect(row[13]).toBe('"Getränke Müller GmbH"');
  });

  /**
   * Semicolons separate columns and quotes delimit fields, so a crafted
   * supplier name would otherwise shift everything after it. These names arrive
   * by email from anyone who learns the inbox address.
   */
  it("neutralises semicolons and quotes in a supplier name", () => {
    const row = lines([{ ...booking, text: 'Meier; "Sohn" GmbH;;;9999' }])[2];
    expect(row?.split(";")).toHaveLength(COLUMNS.length);
    expect(row).toContain(`"Meier, 'Sohn' GmbH,,,9999"`);
  });

  it("uses CRLF and ends the last line", () => {
    const raw = buildBuchungsstapel([booking], options).toString("latin1");
    expect(raw.endsWith("\r\n")).toBe(true);
    expect(raw.includes("\n\n")).toBe(false);
  });

  it("encodes the file as Windows-1252", () => {
    const buffer = buildBuchungsstapel([booking], options);
    expect([...buffer]).toContain(0xe4); // ä as one byte, not two
    expect(buffer.toString("utf8")).not.toContain("Getränke");
  });

  /**
   * Belegdatum carries no year, so a document from another fiscal year would be
   * booked into this one without any sign of it.
   */
  it("refuses a booking outside the fiscal year", () => {
    expect(() =>
      lines([{ ...booking, documentDate: new Date("2024-08-27T00:00:00Z") }]),
    ).toThrow(/outside the fiscal year/);
  });

  it("validates the consultant, client and account length", () => {
    expect(() => lines([booking], { beraterNumber: 999 })).toThrow(/Beraternummer/);
    expect(() => lines([booking], { mandantNumber: 0 })).toThrow(/Mandantennummer/);
    expect(() => lines([booking], { accountLength: 3 })).toThrow(/Sachkontenlänge/);
    expect(() => lines([{ ...booking, grossAmount: Number.NaN }])).toThrow(DatevError);
  });

  it("writes an empty stapel rather than failing on an empty period", () => {
    const out = lines([]);
    expect(out).toHaveLength(3); // header, captions, trailing newline
  });

  it("names the file after the consultant, client and period", () => {
    expect(datevFilename(options)).toBe(
      "EXTF_Buchungsstapel_1234567_42_20260801-20260831.csv",
    );
  });
});
