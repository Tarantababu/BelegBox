import type { LegalClass, ProfileInfo } from "./types.js";

interface ProfileRule {
  /** Matched against the lower-cased guideline URN. */
  match: (urn: string) => boolean;
  name: string;
  legalClass: LegalClass;
  cius?: string;
}

const XRECHNUNG_CIUS = "urn:xoev-de:kosit:standard:xrechnung";

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
    match: (u) => u.includes(XRECHNUNG_CIUS),
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
