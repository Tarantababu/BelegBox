import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { detect, DetectionError } from "@belegbox/core-invoice";
import {
  extractEmbeddedFiles,
  looksLikePdf,
  selectInvoiceCandidates,
} from "@belegbox/ingest";
import { describe, expect, it } from "vitest";

/**
 * The official ZUGFeRD corpus, classified.
 *
 * 239 real files - every ZUGFeRD profile across v1 and v2, XRechnung in three
 * syntaxes, Peppol BIS, fatturaPA, and one scanned PDF with nothing inside it.
 * They are what a German business actually receives, which is the only reason
 * to test against them rather than against fixtures we wrote ourselves: our own
 * fixtures agree with our own assumptions by construction.
 *
 * What this asserts is not "everything validates". Most of these documents are
 * not supposed to pass, and several are not supposed to be e-invoices at all.
 * It asserts something narrower and more useful: **every file gets a considered
 * answer.** Detected with a named profile, or refused with a reason we can put
 * in front of a user. Never an unexplained throw, never a silent
 * misclassification.
 *
 * The corpus is ~170 MB and is not committed. Run
 * `scripts/fetch-zugferd-corpus.sh` to vendor it at the pinned commit; without
 * it this suite skips, so a clone stays cheap.
 */
const VENDOR = join(import.meta.dirname, "../../../corpus/vendor/zugferd-corpus");

const present = await stat(VENDOR).then(
  () => true,
  () => false,
);
const suite = present ? describe : describe.skip;

interface Classification {
  outcome: "detected" | "refused" | "no_xml_in_pdf";
  format?: string;
  profile?: string;
  legalClass?: string;
  /** The DetectionError code, which is also the explain template key suffix. */
  reason?: string;
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(p)));
    else if (/\.(xml|pdf)$/i.test(entry.name)) out.push(p);
  }
  return out;
}

/**
 * The ingest path a real document takes: unwrap the PDF/A-3 if there is one,
 * then detect. Deliberately the production functions, not a reimplementation -
 * a corpus test that exercises its own copy of the logic proves nothing.
 */
function classify(bytes: Buffer): Classification {
  let xml = bytes;

  if (looksLikePdf(bytes)) {
    const candidates = selectInvoiceCandidates(extractEmbeddedFiles(bytes).files);
    const first = candidates[0];
    if (!first) return { outcome: "no_xml_in_pdf" };
    xml = first.bytes;
  }

  try {
    const d = detect(xml);
    return {
      outcome: "detected",
      format: d.format,
      profile: d.profile.name,
      legalClass: d.profile.legalClass,
    };
  } catch (err) {
    if (err instanceof DetectionError) return { outcome: "refused", reason: err.code };
    throw err;
  }
}

// 239 files and ~170 MB off disk. The default 5 s is for unit tests.
const TIMEOUT = 120_000;

suite("ZUGFeRD corpus", () => {
  it("classifies every file, and the classification is stable", async () => {
    const files = (await walk(VENDOR)).sort();
    expect(files.length).toBeGreaterThan(200);

    const summary: Record<string, Classification> = {};
    for (const file of files) {
      summary[relative(VENDOR, file)] = classify(await readFile(file));
    }

    // The snapshot is the regression surface. A profile that changes class, a
    // PDF that stops extracting, a new detection reason - each arrives as a
    // reviewable line in a diff rather than as a number that moved.
    expect(summary).toMatchSnapshot();
  }, TIMEOUT);

  it("leaves nothing unexplained", async () => {
    const files = await walk(VENDOR);
    const unexplained: string[] = [];

    for (const file of files) {
      const c = classify(await readFile(file));
      // "unknown_root" is the honest answer for XML we genuinely do not
      // recognise. It is not an honest answer for a format we can name, and
      // every format in this corpus is one we can name.
      if (c.outcome === "refused" && c.reason === "unknown_root") {
        unexplained.push(relative(VENDOR, file));
      }
    }

    expect(unexplained).toEqual([]);
  }, TIMEOUT);

  it("does not silently truncate an embedded invoice", async () => {
    // The bug this guards: `/Length 200 0 R` is an indirect reference, and
    // reading 200 as a byte count yielded a well-formed 200-byte prefix of a
    // 6526-byte invoice. Extraction "succeeded" and the XML parser then failed
    // with "Pi Tag is not closed", which points at nothing useful.
    const files = (await walk(VENDOR)).filter((f) => extname(f).toLowerCase() === ".pdf");
    const suspicious: string[] = [];

    for (const file of files) {
      const bytes = await readFile(file);
      for (const embedded of selectInvoiceCandidates(extractEmbeddedFiles(bytes).files)) {
        const text = embedded.bytes.toString("utf8").trimEnd();
        // A complete invoice ends with its own closing tag. A truncated one
        // ends mid-element, wherever the wrong byte count happened to land.
        if (!text.endsWith(">")) suspicious.push(relative(VENDOR, file));
      }
    }

    expect(suspicious).toEqual([]);
  }, TIMEOUT);
});
