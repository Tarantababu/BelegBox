import type { LegalClass, ProfileInfo } from "./types.js";

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
 * The conformance level, which is what decides whether a document is an
 * e-invoice at all.
 *
 * The level is the last colon-separated segment of the guideline URN, and it
 * says the same thing whichever vendor namespace carries it:
 *
 *   urn:factur-x.eu:1p0:minimum
 *   urn:zugferd.de:2p0:minimum
 *   urn:cen.eu:en16931:2017#conformant#urn:zugferd.de:2p0:extended
 *   urn:cen.eu:en16931:2017:compliant:factur-x.eu:1p0:basic
 *
 * Keying on the level rather than on the vendor is the fix for a real hole.
 * The rules used to read `includes("factur-x.eu") && endsWith(":minimum")`, so
 * ZUGFeRD 2.0's own namespace - `urn:zugferd.de:2p0:minimum`, which is in the
 * official ZUGFeRD corpus - matched nothing and fell through to the unknown
 * branch. That branch happens to answer `not_einvoice`, so the verdict looked
 * correct while D-001 never fired: no finding, no explanation, no reason given.
 * The same hole would have marked `urn:zugferd.de:2p0:basic` not_einvoice,
 * which is simply wrong - BASIC is a full e-invoice.
 *
 * D-001: MINIMUM and BASIC WL carry no line-level data. They are accounting
 * previews, not invoices, and most suppliers sending them believe otherwise.
 */
const LEVELS: Array<{ suffix: string; name: string; legalClass: LegalClass }> = [
  { suffix: "minimum", name: "MINIMUM", legalClass: "not_einvoice" },
  { suffix: "basicwl", name: "BASIC WL", legalClass: "not_einvoice" },
  { suffix: "basic", name: "BASIC", legalClass: "einvoice" },
  { suffix: "extended", name: "EXTENDED", legalClass: "einvoice" },
  { suffix: "comfort", name: "COMFORT", legalClass: "einvoice" },
  { suffix: "en16931", name: "EN 16931 (COMFORT)", legalClass: "einvoice" },
];

/** Vendor markers for the ZUGFeRD / Factur-X family, which is level-bearing. */
const ZUGFERD_MARKERS = ["factur-x.eu", "zugferd.de"];

/** Peppol BIS Billing 3.0, which appears bare and as an EN 16931 refinement. */
const PEPPOL_MARKER = "urn:fdc:peppol.eu:2017:poacc:billing";

function levelOf(urn: string): (typeof LEVELS)[number] | undefined {
  const last = urn.split(":").pop() ?? "";
  return LEVELS.find((l) => l.suffix === last);
}
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
 *
 * Likewise a ZUGFeRD URN whose conformance level we do not recognise. Knowing
 * the family without knowing the level tells us nothing about whether there is
 * line-level data, and guessing "e-invoice" on a profile we cannot name is the
 * one direction that is unsafe.
 */
export function classifyProfile(rawUrn: string): ProfileInfo {
  const urn = rawUrn.trim();
  const needle = urn.toLowerCase();

  // ZUGFeRD / Factur-X first: its URNs embed the EN 16931 one, so testing for
  // EN 16931 before the level would swallow every profile into "COMFORT".
  if (ZUGFERD_MARKERS.some((marker) => needle.includes(marker))) {
    const level = levelOf(needle);
    if (!level) {
      return {
        urn,
        name: "ZUGFeRD / Factur-X, unrecognised conformance level",
        legalClass: "not_einvoice",
      };
    }
    return { urn, name: `ZUGFeRD 2.x / Factur-X ${level.name}`, legalClass: level.legalClass };
  }

  if (XRECHNUNG_CIUS.some((cius) => needle.includes(cius))) {
    const version = xrechnungVersion(urn);
    return {
      urn,
      name: version ? `XRechnung ${version}` : "XRechnung",
      legalClass: "einvoice",
      cius: "xrechnung",
    };
  }

  if (needle.includes(PEPPOL_MARKER)) {
    return {
      urn,
      name: "Peppol BIS Billing 3.0",
      legalClass: "einvoice",
      cius: "peppol-bis",
    };
  }

  if (needle.startsWith("urn:cen.eu:en16931:2017")) {
    return { urn, name: "EN 16931 (COMFORT)", legalClass: "einvoice" };
  }

  return { urn, name: "Unrecognised profile", legalClass: "not_einvoice" };
}
