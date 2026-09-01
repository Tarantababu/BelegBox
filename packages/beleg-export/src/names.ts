import type { DocumentFormat } from "./types.js";

/**
 * Names the file a Steuerberater sees when the bundle is unzipped.
 *
 * Two jobs, and the second is a security boundary. The name has to let a person
 * match a file to a line in the Buchungsstapel - so it carries the issue date,
 * the invoice number DATEV puts in Belegfeld 1, and the supplier. And it has to
 * be built rather than taken: `documents.filename` is whatever an email
 * attachment was called, which is attacker-controlled, and it never appears
 * here.
 */

/**
 * Folded to ASCII.
 *
 * Not a display concern. A ZIP entry name is UTF-8 here, but it is extracted on
 * a German Windows machine by whatever the Steuerberater has installed, and
 * older tools still read entry names as the local code page. `Şahin` becoming
 * mojibake in a folder listing is survivable; the same tool refusing the file
 * is not. The transliteration is the German one, so `Müller` is `Mueller`
 * rather than `Muller` - the spelling the recipient expects.
 */
function fold(value: string): string {
  return value
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue")
    .replace(/Ä/g, "Ae").replace(/Ö/g, "Oe").replace(/Ü/g, "Ue")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[ıİ]/g, "i")
    .replace(/[şŞ]/g, "s")
    .replace(/[ğĞ]/g, "g")
    .replace(/[çÇ]/g, "c");
}

/**
 * Everything outside this set becomes a hyphen.
 *
 * An allowlist, not a denylist of the characters that happen to be dangerous
 * today: this string ends up as a path on a filesystem nobody here controls.
 * Dots are permitted inside but a leading one is stripped, so nothing lands as
 * a hidden file or as `..`.
 */
function slug(value: string, max: number): string {
  const cleaned = fold(value)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/[.-]+$/, "");
  return cleaned.slice(0, max);
}

/**
 * The extension, from what the bytes are.
 *
 * Sniffed rather than inferred from `format`. A ZUGFeRD document is normally an
 * archived PDF with the invoice embedded, so `format` usually agrees - but not
 * always, and an entry named `.pdf` that holds XML is a file the recipient
 * double-clicks and their reader refuses. The bytes cannot be wrong about
 * themselves.
 *
 * Never from `documents.filename`: that is whatever an email attachment was
 * called, and a supplier does not get to decide that an archived original ends
 * in `.exe`.
 */
export function extensionFor(
  format: string | null,
  contentType: string | null,
  bytes?: Buffer,
): string {
  if (bytes && bytes.length >= 5) {
    if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
    const head = bytes.subarray(0, 512).toString("latin1").trimStart();
    if (head.startsWith("<?xml") || head.startsWith("<")) return "xml";
  }

  if (format === "zugferd") return "pdf";
  if (contentType?.includes("pdf")) return "pdf";
  if (format && format !== "other") return "xml";
  if (contentType?.includes("xml")) return "xml";
  return "bin";
}

export interface NameInput {
  issuedAt: string | null;
  invoiceNumber: string | null;
  supplierName: string | null;
  format: DocumentFormat | string | null;
  contentType: string | null;
  /** The archived bytes, so the extension describes the file that is actually there. */
  bytes?: Buffer;
  /** Falls back to this when there is nothing else to name the file after. */
  documentId: string;
}

/**
 * Builds one entry name, unique within the bundle.
 *
 * `taken` is mutated: a supplier who sends the same invoice number twice in a
 * period is common enough that a collision must resolve rather than throw, and
 * the ZIP writer refuses duplicates outright.
 */
export function entryName(input: NameInput, taken: Set<string>): string {
  const date = input.issuedAt ?? "ohne-datum";
  const number = slug(input.invoiceNumber ?? "", 40);
  const supplier = slug(input.supplierName ?? "", 60);

  const middle = [number, supplier].filter(Boolean).join("_");
  const stem = middle ? `${date}_${middle}` : `${date}_${input.documentId.slice(0, 8)}`;
  const extension = extensionFor(input.format, input.contentType, input.bytes);

  let candidate = `${stem}.${extension}`;
  let counter = 2;
  while (taken.has(candidate)) {
    candidate = `${stem}_${counter}.${extension}`;
    counter += 1;
  }
  taken.add(candidate);
  return candidate;
}
