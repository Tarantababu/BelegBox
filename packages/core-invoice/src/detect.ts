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

function resolveFormat(
  syntax: Syntax,
  profileUrn: string,
  ublProfileId: string | undefined,
): DocumentFormat {
  const urn = profileUrn.toLowerCase();

  if (urn.includes("urn:xoev-de:kosit:standard:xrechnung")) {
    return syntax === "ubl" ? "xrechnung_ubl" : "xrechnung_cii";
  }
  if (urn.includes("factur-x.eu")) return "zugferd";
  if (
    urn.startsWith("urn:fdc:peppol.eu") ||
    ublProfileId?.toLowerCase().startsWith("urn:fdc:peppol.eu")
  ) {
    return "peppol_bis";
  }
  // Bare EN 16931 in CII is how ZUGFeRD EN16931/COMFORT identifies itself.
  if (syntax === "cii" && urn.startsWith("urn:cen.eu:en16931:2017")) {
    return "zugferd";
  }
  return "other";
}

/**
 * Identifies syntax, format and profile of a bare e-invoice XML document.
 *
 * Scope note: this handles XML only. A ZUGFeRD invoice arrives as a PDF/A-3
 * with the XML embedded; extracting it is the ingest worker's job (F1 week 1)
 * and this function rejects PDF input explicitly rather than failing obscurely.
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

  const doc = parser.parse(xml) as Node;
  const rootElement = Object.keys(doc).find((k) => !k.startsWith("?")) ?? "";
  const root = doc[rootElement];

  let syntax: Syntax;
  let profileUrn: string | undefined;
  let ublProfileId: string | undefined;
  let invoiceNumber: string | undefined;
  let issueDate: string | undefined;
  let documentTypeCode: string | undefined;

  if (rootElement === "Invoice" || rootElement === "CreditNote") {
    syntax = "ubl";
    profileUrn = text(child(root, "CustomizationID"));
    ublProfileId = text(child(root, "ProfileID"));
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
    format: resolveFormat(syntax, profileUrn, ublProfileId),
    rootElement,
    profile: classifyProfile(profileUrn),
    ...(invoiceNumber ? { invoiceNumber } : {}),
    ...(issueDate ? { issueDate } : {}),
    ...(documentTypeCode ? { documentTypeCode } : {}),
  };
}
