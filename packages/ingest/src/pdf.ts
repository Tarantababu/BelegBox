import { inflateRawSync, inflateSync } from "node:zlib";

/**
 * ZUGFeRD / Factur-X filenames, lower-cased. The XML is always one of these,
 * and a PDF/A-3 may legitimately carry unrelated attachments beside it.
 */
const KNOWN_INVOICE_FILENAMES = new Set([
  "factur-x.xml",
  "zugferd-invoice.xml",
  "xrechnung.xml",
  "order-x.xml",
]);

export interface EmbeddedFile {
  filename: string;
  bytes: Buffer;
  /** True when the name matches a known ZUGFeRD / Factur-X invoice filename. */
  isKnownInvoiceName: boolean;
}

export interface PdfExtractionResult {
  files: EmbeddedFile[];
  /** Set when nothing could be extracted and the reason is worth surfacing. */
  problem?: string;
}

export function looksLikePdf(bytes: Buffer): boolean {
  return bytes.subarray(0, 5).toString("latin1") === "%PDF-";
}

/**
 * Pulls embedded files out of a PDF/A-3 container.
 *
 * This is a deliberately narrow scanner, not a PDF parser: it walks indirect
 * objects looking for `/Type /EmbeddedFile` streams and inflates them. It does
 * not resolve the document catalogue, the name tree, or cross-reference
 * streams.
 *
 * That is a knowing trade for F1 week 1. Authoritative extraction moves to
 * mustang-svc in week 2-3, where Mustangproject does it properly against the
 * real specification. Until then the contract is: extract what is
 * unambiguous, and when anything is unclear return a problem rather than a
 * guess. A document whose XML cannot be extracted becomes `not_einvoice` with
 * a finding - it is never silently dropped, and never reported as clean.
 */
export function extractEmbeddedFiles(pdf: Buffer): PdfExtractionResult {
  if (!looksLikePdf(pdf)) {
    return { files: [], problem: "Not a PDF container." };
  }

  // latin1 keeps a 1:1 byte-to-char mapping, so string offsets are byte offsets.
  const text = pdf.toString("latin1");

  if (/\/Encrypt\b/.test(text)) {
    return {
      files: [],
      problem:
        "PDF is encrypted. Ask the supplier to send the XRechnung XML directly, or an unencrypted ZUGFeRD PDF.",
    };
  }

  const names = filespecNames(text);
  const files: EmbeddedFile[] = [];
  const problems: string[] = [];

  const objectRe = /(\d+)\s+(\d+)\s+obj\b/g;
  let match: RegExpExecArray | null;

  while ((match = objectRe.exec(text)) !== null) {
    const objNum = Number(match[1]);
    const bodyStart = match.index + match[0].length;
    const endObj = text.indexOf("endobj", bodyStart);
    const streamStart = text.indexOf("stream", bodyStart);

    // No stream inside this object, or the stream belongs to a later one.
    if (streamStart < 0 || (endObj >= 0 && streamStart > endObj)) continue;

    const dict = text.slice(bodyStart, streamStart);
    if (!isEmbeddedFileDict(dict)) continue;

    const raw = streamBytes(pdf, text, streamStart, dict);
    if (!raw) {
      problems.push(`Object ${objNum}: stream is truncated.`);
      continue;
    }

    let bytes: Buffer;
    try {
      bytes = decodeStream(raw, dict);
    } catch (err) {
      problems.push(`Object ${objNum}: cannot decode stream (${(err as Error).message}).`);
      continue;
    }

    const filename = names.get(objNum) ?? `embedded-${objNum}.xml`;
    files.push({
      filename,
      bytes,
      isKnownInvoiceName: KNOWN_INVOICE_FILENAMES.has(filename.toLowerCase()),
    });
  }

  if (files.length === 0) {
    return {
      files,
      problem:
        problems.length > 0
          ? problems.join(" ")
          : "No embedded file found. A ZUGFeRD PDF carries the XML as a PDF/A-3 attachment; this PDF has none, so it is a paper-equivalent invoice, not an e-invoice.",
    };
  }
  return problems.length > 0 ? { files, problem: problems.join(" ") } : { files };
}

function isEmbeddedFileDict(dict: string): boolean {
  if (/\/Type\s*\/EmbeddedFile\b/.test(dict)) return true;
  // Some producers omit /Type and only set the MIME subtype (text#2Fxml).
  return /\/Subtype\s*\/(?:text#2Fxml|application#2Fxml|text\/xml)/i.test(dict);
}

/**
 * Maps an embedded-file object number to the filename declared in the filespec
 * that points at it: `/F (factur-x.xml) ... /EF << /F 12 0 R >>`.
 *
 * A filespec living inside a compressed object stream is invisible to this
 * scan; the caller then falls back to a synthetic name, which costs nothing
 * because the content is what gets classified.
 */
function filespecNames(text: string): Map<number, string> {
  const out = new Map<number, string>();
  const efRe = /\/EF\s*<<([^>]*)>>/g;
  let m: RegExpExecArray | null;

  while ((m = efRe.exec(text)) !== null) {
    const refs = [...(m[1] ?? "").matchAll(/\/(?:F|UF)\s+(\d+)\s+\d+\s+R/g)].map((r) =>
      Number(r[1]),
    );
    if (refs.length === 0) continue;

    // The filespec's own /F (name) sits just before the /EF entry.
    const before = text.slice(Math.max(0, m.index - 400), m.index);
    const nameMatch = [...before.matchAll(/\/(?:UF|F)\s*\(((?:\\.|[^\\)])*)\)/g)].pop();
    if (!nameMatch?.[1]) continue;

    const filename = decodePdfString(nameMatch[1]);
    for (const ref of refs) {
      if (!out.has(ref)) out.set(ref, filename);
    }
  }
  return out;
}

function decodePdfString(raw: string): string {
  return raw.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, esc: string) => {
    switch (esc) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "(":
        return "(";
      case ")":
        return ")";
      case "\\":
        return "\\";
      default:
        return String.fromCharCode(Number.parseInt(esc, 8));
    }
  });
}

function streamBytes(
  pdf: Buffer,
  text: string,
  streamKeywordAt: number,
  dict: string,
): Buffer | null {
  // The stream data begins after the EOL that follows the `stream` keyword.
  let start = streamKeywordAt + "stream".length;
  if (text[start] === "\r") start += 1;
  if (text[start] === "\n") start += 1;

  const declared = /\/Length\s+(\d+)\b/.exec(dict)?.[1];
  if (declared) {
    const end = start + Number(declared);
    if (end <= pdf.length) return pdf.subarray(start, end);
    // Length is an indirect reference or simply wrong; fall through to endstream.
  }

  const end = text.indexOf("endstream", start);
  if (end < 0) return null;

  let stop = end;
  if (text[stop - 1] === "\n") stop -= 1;
  if (text[stop - 1] === "\r") stop -= 1;
  return pdf.subarray(start, stop);
}

function decodeStream(raw: Buffer, dict: string): Buffer {
  const filter = /\/Filter\s*\/?\[?\s*\/?([A-Za-z0-9]+)/.exec(dict)?.[1];

  if (!filter) return raw;
  if (filter === "FlateDecode") {
    try {
      return inflateSync(raw);
    } catch {
      // Some producers emit raw deflate without the zlib header.
      return inflateRawSync(raw);
    }
  }
  throw new Error(`unsupported filter /${filter}`);
}

/**
 * Picks the invoice XML out of everything embedded in the container.
 *
 * Known ZUGFeRD filenames win. Otherwise every embedded file is returned for
 * the detector to judge - guessing here would mean discarding the one
 * attachment that mattered.
 */
export function selectInvoiceCandidates(files: EmbeddedFile[]): EmbeddedFile[] {
  const known = files.filter((f) => f.isKnownInvoiceName);
  if (known.length > 0) return known;
  return files.filter((f) => looksLikeXml(f.bytes));
}

export function looksLikeXml(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 512).toString("utf8").replace(/^﻿/, "").trimStart();
  return head.startsWith("<");
}
