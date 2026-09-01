import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP, RFC 6238.
 *
 * PRD § 10.3 makes MFA mandatory for the owner and accountant roles. Those are
 * the accounts that can reach ten years of a company's invoices and export them
 * to a Steuerberater, so a stolen password alone must not be enough.
 *
 * SHA-1 with 6 digits and a 30-second step, because that is what every
 * authenticator app implements. The HMAC key here is 160 bits of fresh
 * randomness rather than a password, so SHA-1's collision weaknesses do not
 * apply - HMAC-SHA1 remains sound for this.
 */
const DIGITS = 6;
const STEP_SECONDS = 30;
const SECRET_BYTES = 20;

/** How many steps either side of now are accepted. */
const DEFAULT_WINDOW = 1;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[=\s]/g, "");
  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error("Not a base32 secret.");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

/** The code for one time step. */
export function totpCode(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac("sha1", key).update(buffer).digest();
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const binary =
    (((digest[offset] as number) & 0x7f) << 24) |
    (((digest[offset + 1] as number) & 0xff) << 16) |
    (((digest[offset + 2] as number) & 0xff) << 8) |
    ((digest[offset + 3] as number) & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

export interface VerifyTotpOptions {
  /** Steps either side of now. One step is 30 seconds. */
  window?: number;
  now?: Date;
  /**
   * Codes already used, so a captured code cannot be replayed inside its
   * window. Return false to reject. Without this, TOTP defends against a
   * guessed password but not against someone reading the code over a shoulder
   * or off a phishing page within the same 30 seconds.
   */
  consume?: (counter: number) => boolean;
}

export interface TotpResult {
  valid: boolean;
  /**
   * The time step that matched. The caller claims it, so a code cannot be used
   * twice inside its acceptance window - the claim has to be atomic and this
   * function is deliberately synchronous and pure.
   */
  counter?: number;
}

export function verifyTotpStep(
  secret: string,
  code: string,
  options: VerifyTotpOptions = {},
): TotpResult {
  const cleaned = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(cleaned)) return { valid: false };

  const window = options.window ?? DEFAULT_WINDOW;
  const now = options.now ?? new Date();
  const counter = Math.floor(now.getTime() / 1000 / STEP_SECONDS);

  for (let offset = -window; offset <= window; offset += 1) {
    let expected: string;
    try {
      expected = totpCode(secret, counter + offset);
    } catch {
      return { valid: false };
    }
    // Constant-time even though the code is short: an attacker who can measure
    // it can narrow six digits one at a time.
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(cleaned))) {
      const matched = counter + offset;
      if (options.consume && !options.consume(matched)) return { valid: false };
      return { valid: true, counter: matched };
    }
  }
  return { valid: false };
}

/** Boolean form, for callers that claim the step separately. */
export function verifyTotp(
  secret: string,
  code: string,
  options: VerifyTotpOptions = {},
): boolean {
  return verifyTotpStep(secret, code, options).valid;
}

/**
 * The `otpauth://` URI an authenticator app scans.
 *
 * The label carries the account and issuer so a user with several Belegbox
 * accounts can tell them apart in the app.
 */
export function totpUri(secret: string, account: string, issuer = "Belegbox"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Roles that must have MFA before they can be used (PRD § 10.3). */
export const MFA_REQUIRED_ROLES = new Set(["owner", "accountant"]);

export function requiresMfa(role: string): boolean {
  return MFA_REQUIRED_ROLES.has(role);
}
