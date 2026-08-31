import type { AuthVerdict, SenderAuth } from "./types.js";

const VERDICTS = new Set<AuthVerdict>([
  "pass",
  "fail",
  "softfail",
  "neutral",
  "none",
  "unknown",
]);

function toVerdict(raw: string | undefined): AuthVerdict {
  if (!raw) return "unknown";
  const v = raw.toLowerCase();
  // Everything the RFC 8601 registry defines but we do not act on separately
  // (permerror, temperror, policy) collapses to "unknown" rather than "pass".
  return VERDICTS.has(v as AuthVerdict) ? (v as AuthVerdict) : "unknown";
}

/**
 * Parses an RFC 8601 `Authentication-Results` header.
 *
 * Deliberately permissive about shape and strict about outcome: anything not
 * explicitly recognised as a result becomes `unknown`, never `pass`. An
 * unparseable header must not read as a verified sender.
 */
export function parseAuthenticationResults(header: string | undefined): SenderAuth {
  if (!header || header.trim() === "") {
    return { spf: "unknown", dkim: "unknown", dmarc: "unknown" };
  }

  const method = (name: string): string | undefined => {
    const m = new RegExp(`\\b${name}\\s*=\\s*([a-z]+)`, "i").exec(header);
    return m?.[1];
  };

  const dkimDomain = /header\.(?:d|i)\s*=\s*@?([A-Za-z0-9.\-_]+)/i.exec(header)?.[1];

  return {
    spf: toVerdict(method("spf")),
    dkim: toVerdict(method("dkim")),
    dmarc: toVerdict(method("dmarc")),
    ...(dkimDomain ? { dkimDomain } : {}),
    raw: header,
  };
}

/**
 * True when the message carries no positive evidence of its origin.
 *
 * DMARC passing is sufficient on its own - it requires an aligned SPF or DKIM
 * pass by definition. This never blocks ingestion: a legitimate supplier with a
 * misconfigured domain must not have their invoice silently dropped. It raises
 * a warning that surfaces in the UI and feeds D-008.
 */
export function isUnauthenticated(auth: SenderAuth): boolean {
  if (auth.dmarc === "pass") return false;
  return auth.spf !== "pass" && auth.dkim !== "pass";
}

/** True when the sending domain actively failed a check, rather than being silent. */
export function hasAuthFailure(auth: SenderAuth): boolean {
  return (
    auth.dmarc === "fail" ||
    auth.spf === "fail" ||
    auth.spf === "softfail" ||
    auth.dkim === "fail"
  );
}
