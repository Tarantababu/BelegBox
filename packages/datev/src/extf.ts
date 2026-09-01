import { chooseAccounts, type AccountMapping } from "./accounts.js";
import { encodeCp1252 } from "./cp1252.js";

/**
 * DATEV EXTF Buchungsstapel, format version 700 / 13.
 *
 * The v2 prototype emitted `Umsatz;SollHaben;Datum;Konto;Gegenkonto` with a
 * single header line. DATEV would reject that at import, and the shape of the
 * real thing is why:
 *
 *   line 1  the EXTF header - 31 fields naming the format, the consultant, the
 *           client, the fiscal year and the period
 *   line 2  the column captions, every one of them
 *   line 3+ the postings, at the same width as the captions
 *
 * Semicolon-separated, CRLF, Windows-1252. Belegdatum is DDMM - four
 * characters, no year, because the year comes from the fiscal year in the
 * header. The prototype wrote 28082026 into a four-character field.
 */

export const FORMAT_VERSION = 700;
export const FORMAT_CATEGORY = 21;
export const FORMAT_NAME = "Buchungsstapel";
export const FORMAT_REVISION = 13;

/** Fields on the EXTF header line, format version 700. */
export const HEADER_FIELDS = 31;

/**
 * The Buchungsstapel v13 columns, in order.
 *
 * UNVERIFIED against DATEV's own documentation. The structure around them is
 * right - two header lines, semicolons, CRLF, Windows-1252, DDMM - but the
 * exact caption list and count are transcribed rather than checked, and DATEV
 * matches the row width against this line. Diff it against the official
 * Buchungsstapel layout before the first real import; the plan already puts a
 * Steuerberater's test import on the F1 critical path for exactly this reason.
 */
export const COLUMNS = [
  "Umsatz (ohne Soll/Haben-Kz)", "Soll/Haben-Kennzeichen", "WKZ Umsatz", "Kurs",
  "Basis-Umsatz", "WKZ Basis-Umsatz", "Konto", "Gegenkonto (ohne BU-Schlüssel)",
  "BU-Schlüssel", "Belegdatum", "Belegfeld 1", "Belegfeld 2", "Skonto", "Buchungstext",
  "Postensperre", "Diverse Adressnummer", "Geschäftspartnerbank", "Sachverhalt",
  "Zinssperre", "Beleglink",
  "Beleginfo - Art 1", "Beleginfo - Inhalt 1", "Beleginfo - Art 2", "Beleginfo - Inhalt 2",
  "Beleginfo - Art 3", "Beleginfo - Inhalt 3", "Beleginfo - Art 4", "Beleginfo - Inhalt 4",
  "Beleginfo - Art 5", "Beleginfo - Inhalt 5", "Beleginfo - Art 6", "Beleginfo - Inhalt 6",
  "Beleginfo - Art 7", "Beleginfo - Inhalt 7", "Beleginfo - Art 8", "Beleginfo - Inhalt 8",
  "KOST1 - Kostenstelle", "KOST2 - Kostenstelle", "KOST-Menge", "EU-Mitgliedstaat u. UStID",
  "EU-Steuersatz", "Abw. Versteuerungsart", "Sachverhalt L+L", "Funktionsergänzung L+L",
  "BU 49 Hauptfunktionstyp", "BU 49 Hauptfunktionsnummer", "BU 49 Funktionsergänzung",
  "Zusatzinformation - Art 1", "Zusatzinformation- Inhalt 1",
  "Zusatzinformation - Art 2", "Zusatzinformation- Inhalt 2",
  "Zusatzinformation - Art 3", "Zusatzinformation- Inhalt 3",
  "Zusatzinformation - Art 4", "Zusatzinformation- Inhalt 4",
  "Zusatzinformation - Art 5", "Zusatzinformation- Inhalt 5",
  "Zusatzinformation - Art 6", "Zusatzinformation- Inhalt 6",
  "Zusatzinformation - Art 7", "Zusatzinformation- Inhalt 7",
  "Zusatzinformation - Art 8", "Zusatzinformation- Inhalt 8",
  "Zusatzinformation - Art 9", "Zusatzinformation- Inhalt 9",
  "Zusatzinformation - Art 10", "Zusatzinformation- Inhalt 10",
  "Zusatzinformation - Art 11", "Zusatzinformation- Inhalt 11",
  "Zusatzinformation - Art 12", "Zusatzinformation- Inhalt 12",
  "Zusatzinformation - Art 13", "Zusatzinformation- Inhalt 13",
  "Zusatzinformation - Art 14", "Zusatzinformation- Inhalt 14",
  "Zusatzinformation - Art 15", "Zusatzinformation- Inhalt 15",
  "Zusatzinformation - Art 16", "Zusatzinformation- Inhalt 16",
  "Zusatzinformation - Art 17", "Zusatzinformation- Inhalt 17",
  "Zusatzinformation - Art 18", "Zusatzinformation- Inhalt 18",
  "Zusatzinformation - Art 19", "Zusatzinformation- Inhalt 19",
  "Zusatzinformation - Art 20", "Zusatzinformation- Inhalt 20",
  "Stück", "Gewicht", "Zahlweise", "Forderungsart", "Veranlagungsjahr",
  "Zugeordnete Fälligkeit", "Skontotyp", "Auftragsnummer", "Buchungstyp",
  "USt-Schlüssel (Anzahlungen)", "EU-Mitgliedstaat (Anzahlungen)",
  "Sachverhalt L+L (Anzahlungen)", "EU-Steuersatz (Anzahlungen)",
  "Erlöskonto (Anzahlungen)", "Herkunft-Kz", "Buchungs GUID",
  "KOST-Datum", "SEPA-Mandatsreferenz", "Skontosperre", "Gesellschaftername",
  "Beteiligtennummer", "Identifikationsnummer", "Zeichnernummer",
  "Postensperre bis", "Bezeichnung SoBil-Sachverhalt", "Kennzeichen SoBil-Buchung",
  "Festschreibung", "Leistungsdatum", "Datum Zuord. Steuerperiode",
  "Fälligkeit", "Generalumkehr (GU)", "Steuersatz", "Land",
  "Abrechnungsreferenz", "BVV-Position", "EU-Mitgliedstaat u. UStID (Ursprung)",
  "EU-Steuersatz (Ursprung)",
] as const;

export interface DatevBooking {
  /** Gross amount, always positive. Direction lives in the S/H flag. */
  grossAmount: number;
  /** S for an expense debit, H for a credit. */
  debitCredit: "S" | "H";
  /** Invoice date. The year must fall inside the fiscal year in the header. */
  documentDate: Date;
  /** Belegfeld 1: the supplier's invoice number. */
  invoiceNumber?: string | null;
  /** Buchungstext: what a bookkeeper reads in the ledger. */
  text: string;
  vatCategory?: string | null;
  vatRate?: number | null;
  /** Beleglink, so the posting can be opened back to the archived document. */
  documentLink?: string | null;
  dueDate?: Date | null;
}

export interface DatevExportOptions {
  /** DATEV consultant number, 1001 to 9999999. */
  beraterNumber: number;
  /** DATEV client number, 1 to 99999. */
  mandantNumber: number;
  /** First day of the fiscal year. */
  fiscalYearStart: Date;
  periodFrom: Date;
  periodTo: Date;
  /** 4 to 8. Must match the client's setup or DATEV refuses the import. */
  accountLength?: number;
  accounts: AccountMapping;
  description?: string;
  createdAt?: Date;
  createdBy?: string;
  /**
   * Festschreibung. GoBD wants postings locked, and DATEV treats an unlocked
   * import as provisional - which is what a Steuerberater then has to chase.
   */
  locked?: boolean;
}

export class DatevError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatevError";
  }
}

const pad = (value: number, length: number): string => String(value).padStart(length, "0");

/** DATEV writes amounts with a comma and exactly two decimals. */
function amount(value: number): string {
  if (!Number.isFinite(value)) throw new DatevError("Amount is not a number.");
  return Math.abs(Math.round(value * 100) / 100).toFixed(2).replace(".", ",");
}

/**
 * Belegdatum: four characters, DDMM.
 *
 * The year is implied by the fiscal year in the header. Writing DDMMYYYY - as
 * the prototype did - overflows the field and the import fails.
 */
function ddmm(date: Date): string {
  return `${pad(date.getUTCDate(), 2)}${pad(date.getUTCMonth() + 1, 2)}`;
}

const yyyymmdd = (date: Date): string =>
  `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1, 2)}${pad(date.getUTCDate(), 2)}`;

/**
 * Quotes a text field.
 *
 * Semicolons separate the columns and quotes delimit the field, so a supplier
 * called `Meier; "Sohn" GmbH` would otherwise shift every column after it. The
 * names come from invoices that arrive by email, which makes this a boundary
 * rather than formatting.
 */
function text(value: string, max: number): string {
  const clean = value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/"/g, "'")
    .replace(/;/g, ",")
    .trim()
    .slice(0, max);
  return `"${clean}"`;
}

function header(options: DatevExportOptions): string {
  const createdAt = options.createdAt ?? new Date();
  const stamp =
    yyyymmdd(createdAt) +
    pad(createdAt.getUTCHours(), 2) +
    pad(createdAt.getUTCMinutes(), 2) +
    pad(createdAt.getUTCSeconds(), 2) +
    pad(createdAt.getUTCMilliseconds(), 3);

  // Thirty-one fields, in this order. Written out with their numbers because a
  // miscount here fails the import with a message about the whole file rather
  // than the field, and that is a slow thing to debug against a client's DATEV.
  const fields = [
    '"EXTF"',                                   //  1 Kennzeichen
    FORMAT_VERSION,                             //  2 Versionsnummer
    FORMAT_CATEGORY,                            //  3 Formatkategorie
    `"${FORMAT_NAME}"`,                         //  4 Formatname
    FORMAT_REVISION,                            //  5 Formatversion
    stamp,                                      //  6 Erzeugt am
    "",                                         //  7 Importiert (DATEV fills)
    '"BB"',                                     //  8 Herkunft
    text(options.createdBy ?? "Belegbox", 25),  //  9 Exportiert von
    "",                                         // 10 Importiert von
    options.beraterNumber,                      // 11 Berater
    options.mandantNumber,                      // 12 Mandant
    yyyymmdd(options.fiscalYearStart),          // 13 WJ-Beginn
    options.accountLength ?? 4,                 // 14 Sachkontenlänge
    yyyymmdd(options.periodFrom),               // 15 Datum von
    yyyymmdd(options.periodTo),                 // 16 Datum bis
    text(options.description ?? "Belegbox Export", 30), // 17 Bezeichnung
    '""',                                       // 18 Diktatkürzel
    1,                                          // 19 Buchungstyp: Fibu
    0,                                          // 20 Rechnungslegungszweck
    options.locked === false ? 0 : 1,           // 21 Festschreibung
    '"EUR"',                                    // 22 WKZ
    "",                                         // 23 reserved
    "",                                         // 24 Derivatskennzeichen
    "",                                         // 25 reserved
    "",                                         // 26 reserved
    "",                                         // 27 SKR - left to the client's setup
    "",                                         // 28 Branchenlösungs-Id
    "",                                         // 29 reserved
    "",                                         // 30 reserved
    '""',                                       // 31 Anwendungsinformation
  ];

  if (fields.length !== HEADER_FIELDS) {
    throw new DatevError(
      `Header has ${fields.length} fields; format ${FORMAT_VERSION} requires ${HEADER_FIELDS}.`,
    );
  }
  return fields.join(";");
}

/**
 * Builds a Buchungsstapel.
 *
 * Every row carries all 125 columns. DATEV matches the row width against the
 * caption line, and a short row fails the whole file rather than the posting.
 */
export function buildBuchungsstapel(
  bookings: DatevBooking[],
  options: DatevExportOptions,
): Buffer {
  if (options.beraterNumber < 1001 || options.beraterNumber > 9_999_999) {
    throw new DatevError("Beraternummer must be between 1001 and 9999999.");
  }
  if (options.mandantNumber < 1 || options.mandantNumber > 99_999) {
    throw new DatevError("Mandantennummer must be between 1 and 99999.");
  }
  const accountLength = options.accountLength ?? 4;
  if (accountLength < 4 || accountLength > 8) {
    throw new DatevError("Sachkontenlänge must be between 4 and 8.");
  }

  const fiscalYear = options.fiscalYearStart.getUTCFullYear();
  const rows = bookings.map((booking, index) => {
    const bookingYear = booking.documentDate.getUTCFullYear();
    // DDMM has no year, so a document outside the fiscal year would be booked
    // into the wrong one silently.
    if (bookingYear !== fiscalYear && bookingYear !== fiscalYear + 1) {
      throw new DatevError(
        `Booking ${index + 1} is dated ${bookingYear}, outside the fiscal year starting ${fiscalYear}. Belegdatum carries no year.`,
      );
    }

    const chosen = chooseAccounts(options.accounts, booking);
    const columns = new Array<string>(COLUMNS.length).fill("");

    columns[0] = amount(booking.grossAmount);
    columns[1] = `"${booking.debitCredit}"`;
    columns[2] = '"EUR"';
    columns[6] = chosen.account;
    columns[7] = chosen.contraAccount;
    columns[8] = chosen.bookingKey;
    columns[9] = ddmm(booking.documentDate);
    columns[10] = text(booking.invoiceNumber ?? "", 36);
    columns[13] = text(booking.text, 60);
    if (booking.documentLink) columns[19] = text(booking.documentLink, 210);
    columns[113] = options.locked === false ? "0" : "1"; // Festschreibung
    if (booking.dueDate) columns[116] = yyyymmdd(booking.dueDate); // Fälligkeit

    return columns.join(";");
  });

  const content = [
    header(options),
    COLUMNS.map((caption) => `"${caption}"`).join(";"),
    ...rows,
  ].join("\r\n");

  // Trailing CRLF: DATEV treats the last line as terminated.
  return encodeCp1252(`${content}\r\n`);
}

export function datevFilename(options: DatevExportOptions): string {
  return `EXTF_Buchungsstapel_${options.beraterNumber}_${options.mandantNumber}_${yyyymmdd(options.periodFrom)}-${yyyymmdd(options.periodTo)}.csv`;
}
