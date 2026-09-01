import { encodeCp1252 } from "@belegbox/datev";
import type { BelegSource, SkippedBeleg } from "./types.js";

/**
 * The index that makes the bundle usable.
 *
 * Every document in the period gets a row, including the ones that are not in
 * the ZIP. A Steuerberater reconciling the Buchungsstapel against the folder
 * needs to be able to account for each posting, and "the file simply is not
 * there" is not an answer they can act on.
 *
 * Windows-1252 with semicolons, like the Buchungsstapel beside it and for the
 * same reason: this is opened in Excel on a German Windows machine, where a
 * UTF-8 CSV arrives with every umlaut broken.
 */

export const MANIFEST_NAME = "Belegverzeichnis.csv";

const COLUMNS = [
  "Datei",
  "Rechnungsnummer",
  "Lieferant",
  "Rechnungsdatum",
  "Betrag brutto",
  "Status",
  "SHA-256",
  "Archivtag",
  "Merkle-Wurzel des Tages",
  "Im Paket",
  "Hinweis",
] as const;

const STATUS_LABELS: Record<string, string> = {
  clean: "geprüft",
  form_error: "Formfehler",
  content_error: "inhaltlicher Befund",
  not_einvoice: "keine E-Rechnung",
  pending: "in Prüfung",
};

/**
 * Why a document is missing, in words the recipient can act on.
 *
 * A hash mismatch is deliberately not softened. It says the archived bytes and
 * the stored bytes disagree, which is a finding about the archive that the
 * person holding the bundle should escalate rather than work around.
 */
const SKIP_NOTES: Record<SkippedBeleg["reason"], string> = {
  not_in_storage: "Original im Speicher nicht gefunden - bitte bei Belegbox melden.",
  hash_mismatch:
    "Die Prüfsumme des gespeicherten Originals weicht von der archivierten ab. Der Beleg wurde deshalb nicht beigelegt - bitte bei Belegbox melden.",
  read_failed: "Original konnte nicht gelesen werden - bitte bei Belegbox melden.",
};

/** Quotes for CSV: a field carrying a semicolon or a quote would split the row. */
function field(value: string | null | undefined): string {
  const text = value ?? "";
  if (!/[";\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

/** German decimal comma, to match the Buchungsstapel. */
function money(value: string | null): string {
  if (value === null) return "";
  return value.replace(".", ",");
}

/** DD.MM.YYYY, the way the rest of the hand-over is written. */
function germanDate(iso: string | null): string {
  if (!iso) return "";
  const [year, month, day] = iso.split("-");
  return year && month && day ? `${day}.${month}.${year}` : iso;
}

export interface ManifestRow {
  source: BelegSource;
  /** Absent when the document is not in the bundle. */
  entryName?: string | undefined;
  skip?: SkippedBeleg | undefined;
}

export interface ManifestHeader {
  tenantName: string;
  from: string;
  to: string;
  generatedAt: Date;
}

/**
 * Builds the manifest.
 *
 * Rows keep the order they were given, which is the order the documents were
 * put into the ZIP - so the CSV and the folder listing read the same way.
 */
export function buildManifest(header: ManifestHeader, rows: ManifestRow[]): Buffer {
  const lines: string[] = [];

  // A preamble rather than a bare table: the file is read on its own, detached
  // from whatever named the download.
  lines.push(
    `${field(`Belegverzeichnis ${header.tenantName}`)};` +
      `${field(`Zeitraum ${germanDate(header.from)} bis ${germanDate(header.to)}`)};` +
      `${field(`erstellt ${germanDate(header.generatedAt.toISOString().slice(0, 10))} (UTC)`)}`,
  );
  lines.push("");
  lines.push(COLUMNS.join(";"));

  for (const row of rows) {
    const { source } = row;
    lines.push(
      [
        field(row.entryName ?? ""),
        field(source.invoiceNumber),
        field(source.supplierName),
        germanDate(source.issuedAt),
        money(source.totalGross),
        field(STATUS_LABELS[source.status] ?? source.status),
        source.rawSha256,
        germanDate(source.archiveDay),
        source.merkleRoot ?? "",
        row.skip ? "nein" : "ja",
        field(row.skip ? SKIP_NOTES[row.skip.reason] : ""),
      ].join(";"),
    );
  }

  // CRLF, because this is read on Windows next to the Buchungsstapel.
  return encodeCp1252(`${lines.join("\r\n")}\r\n`);
}
