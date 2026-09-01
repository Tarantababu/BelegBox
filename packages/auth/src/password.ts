import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";

// promisify loses the options overload, and the options are the whole point.
function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/**
 * scrypt parameters.
 *
 * N=65536, r=8, p=1 costs roughly 64 MB per hash, which is OWASP's listed
 * minimum for scrypt and enough to make offline cracking expensive per guess.
 *
 * argon2id would be the first recommendation, and this is the second: it ships
 * in Node's standard library, so the runtime image needs no native build step
 * and there is no compiled dependency to keep patched. That trade is worth
 * revisiting if a native module becomes acceptable, and the encoding below
 * carries its own algorithm name so a future hash can be a different one
 * without a migration.
 */
const N = 65536;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

/** `scrypt$N$r$p$salt$hash`, both parts base64url. */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) {
    // Length is the only property that reliably buys entropy. Composition rules
    // push people towards P@ssw0rd1! and nothing else.
    throw new Error("Password must be at least 12 characters.");
  }
  if (password.length > 1024) {
    // Unbounded input into a memory-hard function is a denial of service.
    throw new Error("Password must be at most 1024 characters.");
  }

  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, {
    N,
    r: R,
    p: P,
    maxmem: 256 * 1024 * 1024,
  });

  return [
    "scrypt",
    N,
    R,
    P,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

/**
 * Verifies a password against a stored hash.
 *
 * Reads the parameters back out of the hash rather than assuming the current
 * ones, so raising the cost later does not invalidate every existing password.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] as string, "base64url");
    expected = Buffer.from(parts[5] as string, "base64url");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  if (password.length > 1024) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(password.normalize("NFKC"), salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: 256 * 1024 * 1024,
    });
  } catch {
    // Parameters outside what this process will allocate. Refusing beats
    // crashing the login endpoint on a crafted stored value.
    return false;
  }

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** True when a hash was made with weaker parameters than the current ones. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return true;
  return Number(parts[1]) < N || Number(parts[2]) < R || Number(parts[3]) < P;
}

/**
 * A hash to verify against when the account does not exist.
 *
 * Without it, a missing user returns instantly and an existing one takes 60 ms,
 * which turns the login endpoint into an account enumeration oracle.
 */
export const DUMMY_HASH =
  "scrypt$65536$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
