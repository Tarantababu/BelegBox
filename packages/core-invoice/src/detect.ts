import { XMLParser } from "fast-xml-parser";
import { classifyProfile } from "./profiles.js";
import {
  DetectionError,
  type DetectionResult,
  type DocumentFormat,
  type Syntax,
} from "./types.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

type Node = Record<string, unknown>;

/** Reads the text of an element that may or may not carry attributes. */
function text(value: unknown): string | undefined {
  if (typeof value === "string") return value || undefined;
  if (Array.isArray(value)) return text(value[0]);
  if (value && typeof value === "object") {
    const t = (value as Node)["#text"];
    return typeof t === "string" ? t || undefined : undefined;
  }
  return undefined;
}

function child(node: unknown, name: string): unknown {
  if (!node || typeof node !== "object") return undefined;
  const v = (node as Node)[name];
  return Array.isArray(v) ? v[0] : v;
}

function path(node: unknown, ...names: string[]): unknown {
  return names.reduce<unknown>((acc, n) => child(acc, n), node);
}

/** CII carries dates as YYYYMMDD (UNTDID 2379 format 102). */
function normalizeDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }
  return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : raw;
}

/**
 * The stored `documents.format`.
 *
 * Decided from BT-24 CustomizationID alone, which is the specification
 * identifier. BT-23 ProfileID used to be consulted too, and it is the wrong
 * field: it names the business process, not the CIUS. Mustangproject's
 * CII-to-UBL conversion writes `urn:fdc:peppol.eu:2017:poacc:billing:01:1.0`
 * onto plain EN 16931 documents - process 01, nothing to do with Peppol BIS -
 * and reading it filed those invoices as `peppol_bis` while the profile beside
 * them still said EN 16931. Two fields, two answers, one screen.
 */
function resolveFormat(syntax: Syntax, profileUrn: string): DocumentFormat {
  const urn = profileUrn.toLowerCase();

  if (urn.includes("kosit:standard:xrechnung") || urn.includes("kosit:xrechnung")) {
    return syntax === "ubl" ? "xrechnung_ubl" : "xrechnung_cii";
  }
  // Peppol before the ZUGFeRD and EN 16931 tests: its CustomizationID embeds
  // the EN 16931 one as a prefix, so anything checking EN 16931 first claims it.
  if (urn.includes("urn:fdc:peppol.eu:2017:poacc:billing")) return "peppol_bis";
  if (urn.includes("factur-x.eu") || urn.includes("zugferd.de")) return "zugferd";
  if (urn.startsWith("urn:cen.eu:en16931:2017")) {
    // Bare EN 16931 in CII is how ZUGFeRD EN16931/COMFORT identifies itself;
    // in UBL it is just EN 16931.
    return syntax === "cii" ? "zugferd" : "en16931_ubl";
  }
  return "other";
}

/**
 * The namespaces that decide what a `<...:Invoice>` actually is.
 *
 * The local element name is not enough. UBL's Invoice and ZUGFeRD 1.0 RC's
 * Invoice are both called `Invoice`, and with namespace prefixes stripped they
 * are indistinguishable - so every ZUGFeRD 1.0 RC document in the ZUGFeRD
 * corpus was read as UBL and then rejected for "Missing cbc:CustomizationID",
 * an error about a field that could never have been there.
 */
const UBL_NS = "urn:oasis:names:specification:ubl:schema:xsd:";

/** ZUGFeRD 1.0, in both the release-candidate and final namespaces. */
const ZUGFERD_V1_NS = ["urn:ferd:", "urn:un:unece:uncefact:data:standard:cbfbuy:"];

/** Root local names of national formats we can name but must not validate. */
const FOREIGN_ROOTS: Record<string, string> = {
  fatturaelettronica: "fatturaPA (Italy)",
  fatturaelettronicasemplificata: "fatturaPA semplificata (Italy)",
};

interface RawRoot {
  localName: string;
  namespace: string;
}

/**
 * The root element's local name and namespace, read from the raw text.
 *
 * Done before parsing because the parser is configured with
 * `removeNSPrefix: true` - which is right for every field access afterwards and
 * exactly wrong for this one decision.
 */
function rawRoot(xml: string): RawRoot | undefined {
  const body = xml
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "")
    .trimStart();

  const m = /^<(?:([A-Za-z_][\w.-]*):)?([A-Za-z_][\w.-]*)((?:"[^"]*"|'[^']*'|[^>])*)>/.exec(body);
  if (!m) return undefined;

  const [, prefix, localName = "", attrs = ""] = m;
  const nsRe = prefix
    ? new RegExp(`xmlns:${prefix}\\s*=\\s*["']([^"']*)["']`)
    : /xmlns\s*=\s*["']([^"']*)["']/;

  return { localName, namespace: (nsRe.exec(attrs)?.[1] ?? "").toLowerCase() };
}

/**
 * Identifies syntax, format and profile of a bare e-invoice XML document.
 *
 * Scope note: this handles XML only. A ZUGFeRD invoice arrives as a PDF/A-3
 * with the XML embedded; extracting it is the ingest worker's job and this
 * function rejects PDF input explicitly rather than failing obscurely.
 *
 * Documents that are invoices but not EN 16931 - ZUGFeRD 1.0, fatturaPA - are
 * recognised by name and refused by name. They are not errors in the ordinary
 * sense: they are real invoices a German business can genuinely receive, and
 * the recipient's problem is precisely that they are not e-invoices under the
 * 2025 rules. Telling them which format arrived is the useful answer; telling
 * them "unknown root element" is not.
 */
export function detect(input: Buffer | string): DetectionResult {
  const raw = typeof input === "string" ? input : input.toString("utf8");
  const xml = raw.replace(/^﻿/, "").trimStart();

  if (xml.startsWith("%PDF-")) {
    throw new DetectionError(
      "PDF container - extract the embedded XML before detection (ingest worker, F1 week 1).",
      "pdf_container",
    );
  }
  if (!xml.startsWith("<")) {
    throw new DetectionError("Input is not XML.", "not_xml");
  }

  const rootInfo = rawRoot(xml);
  const foreign = FOREIGN_ROOTS[(rootInfo?.localName ?? "").toLowerCase()];
  if (foreign) {
    throw new DetectionError(
      `This is ${foreign}, a national e-invoicing format. It is a valid invoice, but it is not an EN 16931 document and cannot be checked against the German rules.`,
      "foreign_format",
    );
  }

  const doc = parser.parse(xml) as Node;
  const rootElement = Object.keys(doc).find((k) => !k.startsWith("?")) ?? "";
  const root = doc[rootElement];

  // ZUGFeRD 1.0, in either of its two shapes: <rsm:CrossIndustryDocument> in
  // the final namespace, or <rsm:Invoice> in the release-candidate one. It
  // predates EN 16931 entirely, so there is no profile to classify and no
  // ruleset that applies.
  const isZugferdV1 =
    rootElement === "CrossIndustryDocument" ||
    ZUGFERD_V1_NS.some((ns) => (rootInfo?.namespace ?? "").startsWith(ns));
  if (isZugferdV1) {
    throw new DetectionError(
      "This is ZUGFeRD 1.0, which predates EN 16931. Since 1 January 2025 an e-invoice has to follow EN 16931, so this counts as an other invoice - keep it, but it is not an e-invoice.",
      "zugferd_v1",
    );
  }

  let syntax: Syntax;
  let profileUrn: string | undefined;
  let invoiceNumber: string | undefined;
  let issueDate: string | undefined;
  let documentTypeCode: string | undefined;

  if (rootElement === "Invoice" || rootElement === "CreditNote") {
    // An absent namespace is taken as UBL - that is what every hand-authored
    // fixture resolves to. A namespace that is present and is not UBL is named
    // rather than assumed: ZUGFeRD 1.0 RC was exactly this case, and reading it
    // as UBL produced a complaint about a missing UBL field.
    const ns = rootInfo?.namespace ?? "";
    if (ns && !ns.startsWith(UBL_NS)) {
      throw new DetectionError(
        `Root <${rootElement}> is in namespace "${ns}", which is not UBL. Expected ${UBL_NS}Invoice-2 or CreditNote-2.`,
        "unknown_root",
      );
    }
    syntax = "ubl";
    profileUrn = text(child(root, "CustomizationID"));
    invoiceNumber = text(child(root, "ID"));
    issueDate = normalizeDate(text(child(root, "IssueDate")));
    documentTypeCode =
      text(child(root, "InvoiceTypeCode")) ??
      text(child(root, "CreditNoteTypeCode"));
  } else if (rootElement === "CrossIndustryInvoice") {
    syntax = "cii";
    profileUrn = text(
      path(
        root,
        "ExchangedDocumentContext",
        "GuidelineSpecifiedDocumentContextParameter",
        "ID",
      ),
    );
    invoiceNumber = text(path(root, "ExchangedDocument", "ID"));
    issueDate = normalizeDate(
      text(path(root, "ExchangedDocument", "IssueDateTime", "DateTimeString")),
    );
    documentTypeCode = text(path(root, "ExchangedDocument", "TypeCode"));
  } else {
    throw new DetectionError(
      `Unknown root element <${rootElement || "?"}>. Expected Invoice, CreditNote or CrossIndustryInvoice.`,
      "unknown_root",
    );
  }

  if (!profileUrn) {
    throw new DetectionError(
      syntax === "ubl"
        ? "Missing cbc:CustomizationID - cannot determine the EN 16931 profile."
        : "Missing ram:GuidelineSpecifiedDocumentContextParameter/ram:ID - cannot determine the profile.",
      "missing_profile",
    );
  }

  return {
    syntax,
    format: resolveFormat(syntax, profileUrn),
    rootElement,
    profile: classifyProfile(profileUrn),
    ...(invoiceNumber ? { invoiceNumber } : {}),
    ...(issueDate ? { issueDate } : {}),
    ...(documentTypeCode ? { documentTypeCode } : {}),
  };
}
