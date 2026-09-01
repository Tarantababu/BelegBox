import type { LegalClass, ProfileInfo } from "./types.js";

interface ProfileRule {
  /** Matched against the lower-cased guideline URN. */
  match: (urn: string) => boolean;
  name: string;
  legalClass: LegalClass;
  cius?: string;
}

/**
 * XRechnung identifies its CIUS by two different authorities.
 *
 * Up to 2.x it was `urn:xoev-de:kosit:standard:xrechnung`. Version 3.0 moved to
 * `urn:xeinkauf.de:kosit:xrechnung`, and the official validator matches only
 * the new form - a document carrying the old one matches no scenario at all and
 * gets rejected without a single business rule being evaluated. Both are
 * recognised here because both are in circulation.
 */
const XRECHNUNG_CIUS = ["urn:xoev-de:kosit:standard:xrechnung", "urn:xeinkauf.de:kosit:xrechnung"];

/**
 * Order matters: the first match wins, so the two profiles that are NOT
 * e-invoices are tested before the permissive `factur-x` prefix rules.
 */
const RULES: ProfileRule[] = [
  {
    // D-001 - no line-level data, accounting preview only.
    match: (u) => u.includes("factur-x.eu") && u.endsWith(":minimum"),
    name: "ZUGFeRD 2.x / Factur-X MINIMUM",
    legalClass: "not_einvoice",
  },
  {
    // D-001 - "without lines", likewise not an e-invoice.
    match: (u) => u.includes("factur-x.eu") && u.endsWith(":basicwl"),
    name: "ZUGFeRD 2.x / Factur-X BASIC WL",
    legalClass: "not_einvoice",
  },
  {
    match: (u) => XRECHNUNG_CIUS.some((cius) => u.includes(cius)),
    name: "XRechnung",
    legalClass: "einvoice",
    cius: "xrechnung",
  },
  {
    match: (u) => u.includes("factur-x.eu") && u.endsWith(":basic"),
    name: "ZUGFeRD 2.x / Factur-X BASIC",
    legalClass: "einvoice",
  },
  {
    match: (u) => u.includes("factur-x.eu") && u.endsWith(":extended"),
    name: "ZUGFeRD 2.x / Factur-X EXTENDED",
    legalClass: "einvoice",
  },
  {
    match: (u) => u.startsWith("urn:fdc:peppol.eu:2017:poacc:billing"),
    name: "Peppol BIS Billing 3.0",
    legalClass: "einvoice",
    cius: "peppol-bis",
  },
  {
    // Plain EN 16931 (ZUGFeRD calls this profile COMFORT).
    match: (u) => u.startsWith("urn:cen.eu:en16931:2017"),
    name: "EN 16931 (COMFORT)",
    legalClass: "einvoice",
  },
];

/**
 * Extracts the XRechnung CIUS version from a customization URN, e.g.
 * `...xrechnung_3.0` -> `3.0`. The patch level (3.0.2) is a bundle version and
 * is not carried in the URN.
 */
export function xrechnungVersion(urn: string): string | undefined {
  const m = /xrechnung_(\d+\.\d+)/i.exec(urn);
  return m?.[1];
}

/**
 * Classifies a guideline / customization URN.
 *
 * An unknown URN is deliberately NOT treated as an e-invoice: an unrecognised
 * profile must surface to a human rather than pass silently. Downstream this
 * becomes a `warning`, never a `form_error` - only L1/L2 may set the form
 * verdict.
 */
export function classifyProfile(rawUrn: string): ProfileInfo {
  const urn = rawUrn.trim();
  const needle = urn.toLowerCase();

  for (const rule of RULES) {
    if (!rule.match(needle)) continue;

    const version = rule.cius === "xrechnung" ? xrechnungVersion(urn) : undefined;
    return {
      urn,
      name: version ? `${rule.name} ${version}` : rule.name,
      legalClass: rule.legalClass,
      ...(rule.cius ? { cius: rule.cius } : {}),
    };
  }

  return { urn, name: "Unrecognised profile", legalClass: "not_einvoice" };
}
