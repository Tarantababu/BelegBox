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
 * A narrow scanner, not a PDF parser: it walks indirect objects looking for
 * `/Type /EmbeddedFile` streams and inflates them. It does not resolve the
 * document catalogue, the name tree, or cross-reference streams, and it cannot
 * see objects hidden inside a compressed `/ObjStm`.
 *
 * It does now resolve *indirect references* for the two things that decide
 * whether extraction is correct rather than merely successful:
 *
 *   `/Length 200 0 R`  - the byte count of the stream
 *   `/EF 19 0 R`       - the filespec's embedded-file dictionary
 *
 * Both are written that way by Mustangproject's own output and by every
 * ZUGFeRD 1.0 sample in the ZUGFeRD corpus, and taking the first integer after
 * `/Length` used to read `200` as a length - producing a clean, well-formed,
 * 200-byte *prefix* of a 6526-byte invoice. That is the failure mode this
 * scanner most has to avoid: not an error, but a plausible-looking truncation
 * that the XML parser then rejects for an unrelated-sounding reason.
 *
 * So the declared length is now believed only when the bytes it points at are
 * actually followed by `endstream`. When they are not, the keyword wins. A
 * length that disagrees with the container is wrong by definition, and there is
 * no case where guessing is better than measuring.
 *
 * The contract remains: extract what is unambiguous, and when anything is
 * unclear return a problem rather than a guess. A document whose XML cannot be
 * extracted becomes `not_einvoice` with a finding - never silently dropped, and
 * never reported as clean.
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

  const index = indexObjects(text);
  const names = filespecNames(text, index);
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

    const raw = streamBytes(pdf, text, streamStart, dict, index);
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
 * Where each object's body begins and ends, so an indirect reference can be
 * followed without parsing the cross-reference table.
 *
 * Offsets rather than substrings: an embedded invoice is small but the
 * container around it need not be, and there is no reason to copy a megabyte
 * of font stream to read one integer out of a different object.
 */
type ObjectIndex = Map<number, { start: number; end: number }>;

function indexObjects(text: string): ObjectIndex {
  const index: ObjectIndex = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    const num = Number(m[1]);
    const start = m.index + m[0].length;
    const end = text.indexOf("endobj", start);
    // A later generation of the same object number supersedes an earlier one,
    // which is the direction an incremental update writes in.
    index.set(num, { start, end: end < 0 ? text.length : end });
  }
  return index;
}

/** The body of one object, capped - every lookup here reads a short scalar or dict. */
function objectBody(text: string, index: ObjectIndex, num: number, max = 4096): string {
  const at = index.get(num);
  if (!at) return "";
  return text.slice(at.start, Math.min(at.end, at.start + max));
}

/**
 * Resolves `N` or `N 0 R` to a number.
 *
 * The distinction is the whole bug: `/Length 200 0 R` and `/Length 200` are
 * different statements, and reading the first as the second truncates a stream
 * to the *object number* of its length. Matching the reference form first is
 * what keeps them apart.
 */
function resolveNumber(raw: string, text: string, index: ObjectIndex): number | undefined {
  const indirect = /^(\d+)\s+(\d+)\s+R\b/.exec(raw);
  if (indirect) {
    const value = /^\s*(\d+)/.exec(objectBody(text, index, Number(indirect[1]), 64));
    return value ? Number(value[1]) : undefined;
  }
  const direct = /^(\d+)/.exec(raw);
  return direct ? Number(direct[1]) : undefined;
}

/**
 * Maps an embedded-file object number to the filename declared in the filespec
 * that points at it.
 *
 * Two spellings, both in the corpus:
 *
 *   /F (factur-x.xml)       ... /EF << /F 12 0 R >>     inline dictionary
 *   /F (ZUGFeRD-invoice.xml) ... /EF 19 0 R             indirect dictionary
 *
 * Only the first used to be recognised, so every ZUGFeRD 1.0 sample fell back
 * to a synthetic `embedded-93.xml`. That name never matches
 * KNOWN_INVOICE_FILENAMES, which is how a PDF carrying an invoice *and* an
 * unrelated attachment would have had the invoice deselected.
 *
 * A filespec living inside a compressed object stream is still invisible to
 * this scan; the caller then falls back to a synthetic name, which costs
 * nothing on a single-attachment container because the content is what gets
 * classified.
 */
function filespecNames(text: string, index: ObjectIndex): Map<number, string> {
  const out = new Map<number, string>();
  // Anchored on /Type /Filespec so the name and its /EF come from one object
  // rather than from whatever happened to sit within 400 characters.
  const specRe = /\/Type\s*\/Filespec\b/g;
  let m: RegExpExecArray | null;

  while ((m = specRe.exec(text)) !== null) {
    const body = text.slice(m.index, Math.min(text.length, m.index + 1200));
    const nameMatch = /\/(?:UF|F)\s*\(((?:\\.|[^\\)])*)\)/.exec(body);
    if (!nameMatch?.[1]) continue;
    const filename = decodePdfString(nameMatch[1]);

    for (const ref of embeddedFileRefs(body, text, index)) {
      if (!out.has(ref)) out.set(ref, filename);
    }
  }
  return out;
}

/** The object numbers an `/EF` entry points at, inline or indirect. */
function embeddedFileRefs(body: string, text: string, index: ObjectIndex): number[] {
  const ef = /\/EF\s*(<<[\s\S]*?>>|\d+\s+\d+\s+R)/.exec(body)?.[1];
  if (!ef) return [];

  const dict = ef.startsWith("<<")
    ? ef
    : objectBody(text, index, Number(/^(\d+)/.exec(ef)?.[1]));

  return [...dict.matchAll(/\/(?:F|UF)\s+(\d+)\s+\d+\s+R/g)].map((r) => Number(r[1]));
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
  index: ObjectIndex,
): Buffer | null {
  // The stream data begins after the EOL that follows the `stream` keyword.
  let start = streamKeywordAt + "stream".length;
  if (text[start] === "\r") start += 1;
  if (text[start] === "\n") start += 1;

  const declared = /\/Length\s+([^/>\]]+)/.exec(dict)?.[1];
  const length = declared ? resolveNumber(declared.trim(), text, index) : undefined;

  if (length !== undefined) {
    const end = start + length;
    // Believed only if it lands where a stream actually ends. A declared length
    // that does not is wrong about this container, and trusting it produces a
    // well-formed prefix of the truth - which is worse than an error, because
    // nothing downstream can tell a short invoice from a truncated one.
    if (end <= pdf.length && /^\s*endstream/.test(text.slice(end, end + 16))) {
      return pdf.subarray(start, end);
    }
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
