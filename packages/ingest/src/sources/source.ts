import type { InboundMessage } from "../types.js";

export type VerificationResult = { ok: true } | { ok: false; reason: string };

/**
 * One seam for every inbound mail provider.
 *
 * PRD open decision Q2 is Postmark against Mailgun. Both are implemented so the
 * seam is proven rather than assumed - an interface with one implementation is
 * a guess about what varies. Swapping providers is a wiring change in
 * apps/worker, not a change to anything downstream.
 */
export interface IngestSource<Request> {
  readonly provider: InboundMessage["provider"];
  /** Authenticates the webhook itself. Runs before the body is trusted at all. */
  verify(request: Request): VerificationResult;
  normalize(request: Request): InboundMessage;
}

/** Reads a header out of a provider's name/value list, case-insensitively. */
export function findHeader(
  headers: ReadonlyArray<{ name: string; value: string }>,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === wanted)?.value;
}
