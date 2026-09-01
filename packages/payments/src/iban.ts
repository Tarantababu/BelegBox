/**
 * IBAN handling.
 *
 * A payment file with a malformed IBAN is rejected by the bank at upload, which
 * is a bad place to find out. A GiroCode with one is worse: the banking app
 * accepts the scan and the user discovers it while looking at a payment screen.
 */

/** ISO 13616 maximum. Germany is 22. */
const MAX_LENGTH = 34;

export function normalizeIban(iban: string): string {
  return iban.replace(/[\s-]/g, "").toUpperCase();
}

/**
 * ISO 7064 mod-97-10.
 *
 * Computed digit by digit rather than as one big integer: a 34-character IBAN
 * expands past what a JavaScript number can hold exactly, and the silent
 * precision loss would make some invalid IBANs pass.
 */
export function ibanChecksum(iban: string): number {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;

  for (const char of rearranged) {
    const value = char >= "A" && char <= "Z" ? char.charCodeAt(0) - 55 : Number(char);
    if (Number.isNaN(value)) return -1;
    remainder = value > 9 ? (remainder * 100 + value) % 97 : (remainder * 10 + value) % 97;
  }
  return remainder;
}

export function isValidIban(iban: string): boolean {
  const clean = normalizeIban(iban);
  if (clean.length < 15 || clean.length > MAX_LENGTH) return false;
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(clean)) return false;
  return ibanChecksum(clean) === 1;
}

export function ibanCountry(iban: string): string | undefined {
  const clean = normalizeIban(iban);
  return /^[A-Z]{2}/.test(clean) ? clean.slice(0, 2) : undefined;
}

/** Groups of four, the way a person reads one off a screen. */
export function formatIban(iban: string): string {
  return (normalizeIban(iban).match(/.{1,4}/g) ?? []).join(" ");
}

const BIC_PATTERN = /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/;

export function isValidBic(bic: string): boolean {
  return BIC_PATTERN.test(bic.replace(/\s/g, "").toUpperCase());
}
