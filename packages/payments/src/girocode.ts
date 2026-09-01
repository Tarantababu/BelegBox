import { isValidBic, isValidIban, normalizeIban } from "./iban.js";

/**
 * GiroCode payload, EPC-069-12 version 002.
 *
 * Twelve elements, in this order, newline-separated:
 *
 *    1  Service Tag             BCD
 *    2  Version                 002
 *    3  Character set           1 (UTF-8)
 *    4  Identification          SCT
 *    5  BIC                     optional within the EEA in version 002
 *    6  Beneficiary name        max 70
 *    7  Beneficiary IBAN
 *    8  Amount                  EUR#.## , 0.01 to 999999999.99
 *    9  Purpose                 AT-44, max 4
 *   10  Structured remittance   max 35, creditor reference
 *   11  Unstructured remittance max 140
 *   12  Beneficiary information max 70
 *
 * The v2 prototype emitted eleven and never truncated the name, so a supplier
 * with a long legal name produced a payload no app would parse. Elements 10 and
 * 11 are mutually exclusive - the spec allows one or the other, never both.
 */

export const EPC_MAX_BYTES = 331;
const NAME_MAX = 70;
const UNSTRUCTURED_MAX = 140;
const STRUCTURED_MAX = 35;
const INFORMATION_MAX = 70;
const PURPOSE_MAX = 4;

export interface GiroCodeInput {
  beneficiaryName: string;
  iban: string;
  amount: number;
  bic?: string | undefined;
  /** Free-text reference. Mutually exclusive with `structuredReference`. */
  remittance?: string | undefined;
  /** ISO 11649 creditor reference. Mutually exclusive with `remittance`. */
  structuredReference?: string | undefined;
  /** AT-44 purpose code, four characters. */
  purpose?: string | undefined;
  information?: string | undefined;
}

export class GiroCodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GiroCodeError";
  }
}

/**
 * Strips what the payload cannot carry.
 *
 * Newlines are the element separator, so one inside a supplier name would shift
 * every field after it - the amount would be read as the IBAN. Supplier names
 * arrive by email from anyone who learns the inbox address, which makes this a
 * boundary rather than tidying.
 */
function clean(value: string, max: number): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);
}

/** EPC requires a dot separator and at most two decimals. */
function formatAmount(amount: number): string {
  if (!Number.isFinite(amount)) {
    throw new GiroCodeError("Amount is not a number.");
  }
  const rounded = Math.round(amount * 100) / 100;
  if (rounded < 0.01) {
    throw new GiroCodeError("EPC-069-12 requires an amount of at least 0.01 EUR.");
  }
  if (rounded > 999_999_999.99) {
    throw new GiroCodeError("EPC-069-12 allows at most 999999999.99 EUR.");
  }
  return `EUR${rounded.toFixed(2)}`;
}

export function buildGiroCodePayload(input: GiroCodeInput): string {
  const iban = normalizeIban(input.iban);
  if (!isValidIban(iban)) {
    // Refused rather than encoded: a QR that scans into a banking app with a
    // bad IBAN is discovered on a payment screen, which is the worst place.
    throw new GiroCodeError(`"${input.iban}" is not a valid IBAN.`);
  }

  const bic = input.bic ? input.bic.replace(/\s/g, "").toUpperCase() : "";
  if (bic && !isValidBic(bic)) {
    throw new GiroCodeError(`"${input.bic}" is not a valid BIC.`);
  }

  const name = clean(input.beneficiaryName, NAME_MAX);
  if (!name) {
    throw new GiroCodeError("A beneficiary name is required.");
  }

  if (input.remittance && input.structuredReference) {
    throw new GiroCodeError(
      "EPC-069-12 carries either a structured reference or unstructured text, never both.",
    );
  }

  const lines = [
    "BCD",
    "002",
    "1",
    "SCT",
    bic,
    name,
    iban,
    formatAmount(input.amount),
    input.purpose ? clean(input.purpose, PURPOSE_MAX) : "",
    input.structuredReference ? clean(input.structuredReference, STRUCTURED_MAX) : "",
    input.remittance ? clean(input.remittance, UNSTRUCTURED_MAX) : "",
    input.information ? clean(input.information, INFORMATION_MAX) : "",
  ];

  // Trailing empty elements may be omitted, and dropping them buys room against
  // the 331-byte ceiling for names and references that need it.
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const payload = lines.join("\n");
  const bytes = Buffer.byteLength(payload, "utf8");
  if (bytes > EPC_MAX_BYTES) {
    throw new GiroCodeError(
      `Payload is ${bytes} bytes; EPC-069-12 allows ${EPC_MAX_BYTES}. Shorten the reference.`,
    );
  }

  return payload;
}

export function payloadByteLength(payload: string): number {
  return Buffer.byteLength(payload, "utf8");
}
