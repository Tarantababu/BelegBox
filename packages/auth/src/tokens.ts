import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Opaque bearer tokens: session cookies and API keys.
 *
 * 256 bits of entropy, so there is no guessing attack to slow down and a fast
 * hash is the right choice. Passwords need a memory-hard KDF because they are
 * low entropy; these are not, and using scrypt here would only add 60 ms to
 * every authenticated request.
 */
const TOKEN_BYTES = 32;

export type ApiEnvironment = "live" | "test";

export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * `sk_live_…` / `sk_test_…` per PRD § 8.2.
 *
 * The key type decides the environment, so integrators never point at the wrong
 * base URL - the single largest source of integration friction the PRD
 * identifies. The prefix is also what secret scanners match on, which is why it
 * is a fixed literal rather than something configurable.
 */
export function generateApiKey(environment: ApiEnvironment): {
  token: string;
  prefix: string;
} {
  const secret = randomBytes(TOKEN_BYTES).toString("base64url");
  const token = `sk_${environment}_${secret}`;
  // Enough to identify a key in a list, far too little to reconstruct it.
  return { token, prefix: token.slice(0, 15) };
}

export function environmentOf(token: string): ApiEnvironment | undefined {
  if (token.startsWith("sk_live_")) return "live";
  if (token.startsWith("sk_test_")) return "test";
  return undefined;
}

/**
 * Hashes a token for storage.
 *
 * A database leak then yields nothing usable, the same reason passwords are
 * hashed. Lookup is by hash, so the plaintext exists only in the client's
 * cookie or the integrator's configuration.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time comparison for anything secret that is compared directly. */
export function secureEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}
