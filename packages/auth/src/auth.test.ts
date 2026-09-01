import { describe, expect, it, vi } from "vitest";
import {
  attemptLogin,
  countsAsFailure,
  type LoginCandidate,
} from "./login.js";
import { DUMMY_HASH, hashPassword, needsRehash, verifyPassword } from "./password.js";
import {
  environmentOf,
  generateApiKey,
  generateRecoveryCode,
  generateRecoveryCodes,
  generateSessionToken,
  hashRecoveryCode,
  hashToken,
  secureEquals,
} from "./tokens.js";
import { base32Decode, base32Encode, generateTotpSecret, requiresMfa, totpCode, totpUri, verifyTotp } from "./totp.js";

const PASSWORD = "correct horse battery staple";

describe("passwords", () => {
  it("round-trips", async () => {
    const hash = await hashPassword(PASSWORD);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
    expect(await verifyPassword("wrong password entirely", hash)).toBe(false);
  });

  it("salts, so identical passwords hash differently", async () => {
    expect(await hashPassword(PASSWORD)).not.toBe(await hashPassword(PASSWORD));
  });

  it("normalises unicode, so the same typed password verifies", async () => {
    // Composed vs decomposed e-acute: the same characters to the user.
    const composed = "Passwörtchen-é-123";
    const decomposed = composed.normalize("NFD");
    expect(composed).not.toBe(decomposed);
    expect(await verifyPassword(decomposed, await hashPassword(composed))).toBe(true);
  });

  it("requires length rather than composition", async () => {
    await expect(hashPassword("Sh0rt!")).rejects.toThrow(/at least 12/);
    // Unbounded input into a memory-hard function is a denial of service.
    await expect(hashPassword("a".repeat(2000))).rejects.toThrow(/at most/);
  });

  it("rejects a malformed stored hash rather than throwing", async () => {
    for (const bad of ["", "not-a-hash", "scrypt$1$2$3", "bcrypt$1$2$3$4$5", "scrypt$x$8$1$AA$AA"]) {
      expect(await verifyPassword(PASSWORD, bad), bad).toBe(false);
    }
  });

  it("survives a stored hash with absurd parameters", async () => {
    // A crafted value must not take the login endpoint down trying to allocate.
    const hostile = "scrypt$1048576$64$16$AAAA$AAAA";
    expect(await verifyPassword(PASSWORD, hostile)).toBe(false);
  });

  it("verifies against the dummy hash without throwing", async () => {
    expect(await verifyPassword(PASSWORD, DUMMY_HASH)).toBe(false);
  });

  it("flags a hash made with weaker parameters", async () => {
    expect(needsRehash("scrypt$16384$8$1$AA$BB")).toBe(true);
    expect(needsRehash(await hashPassword(PASSWORD))).toBe(false);
  });
});

describe("tokens", () => {
  it("generates distinct high-entropy session tokens", () => {
    const tokens = new Set(Array.from({ length: 200 }, generateSessionToken));
    expect(tokens.size).toBe(200);
    expect([...tokens][0]).toHaveLength(43); // 32 bytes, base64url
  });

  it("labels API keys by environment so there is no separate sandbox URL", () => {
    const live = generateApiKey("live");
    const test = generateApiKey("test");
    expect(live.token.startsWith("sk_live_")).toBe(true);
    expect(test.token.startsWith("sk_test_")).toBe(true);
    expect(environmentOf(live.token)).toBe("live");
    expect(environmentOf("pk_live_nope")).toBeUndefined();
  });

  it("keeps the prefix too short to reconstruct the key", () => {
    const { token, prefix } = generateApiKey("live");
    expect(token.startsWith(prefix)).toBe(true);
    expect(prefix.length).toBeLessThan(token.length / 2);
  });

  it("stores only the hash", () => {
    const token = generateSessionToken();
    const hash = hashToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(hashToken(token)).toBe(hash);
  });

  it("compares in constant time and rejects length mismatch", () => {
    expect(secureEquals("abc", "abc")).toBe(true);
    expect(secureEquals("abc", "abd")).toBe(false);
    expect(secureEquals("abc", "abcd")).toBe(false);
  });
});

describe("TOTP", () => {
  it("round-trips base32", () => {
    const bytes = Buffer.from("belegbox totp secret");
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
  });

  it("accepts the current code", () => {
    const secret = generateTotpSecret();
    const now = new Date("2026-09-01T10:00:00Z");
    const counter = Math.floor(now.getTime() / 1000 / 30);
    expect(verifyTotp(secret, totpCode(secret, counter), { now })).toBe(true);
  });

  it("accepts one step of clock drift either way, and no more", () => {
    const secret = generateTotpSecret();
    const now = new Date("2026-09-01T10:00:00Z");
    const counter = Math.floor(now.getTime() / 1000 / 30);

    expect(verifyTotp(secret, totpCode(secret, counter - 1), { now })).toBe(true);
    expect(verifyTotp(secret, totpCode(secret, counter + 1), { now })).toBe(true);
    expect(verifyTotp(secret, totpCode(secret, counter + 3), { now })).toBe(false);
  });

  /**
   * Without replay protection TOTP defends against a guessed password but not
   * against a code read off a phishing page within the same 30 seconds.
   */
  it("refuses a code that has already been used", () => {
    const secret = generateTotpSecret();
    const now = new Date("2026-09-01T10:00:00Z");
    const code = totpCode(secret, Math.floor(now.getTime() / 1000 / 30));

    const used = new Set<number>();
    const consume = (counter: number) => (used.has(counter) ? false : (used.add(counter), true));

    expect(verifyTotp(secret, code, { now, consume })).toBe(true);
    expect(verifyTotp(secret, code, { now, consume })).toBe(false);
  });

  it("rejects malformed codes without throwing", () => {
    const secret = generateTotpSecret();
    for (const code of ["", "12345", "1234567", "abcdef", "12 34 56 78"]) {
      expect(verifyTotp(secret, code), code).toBe(false);
    }
  });

  it("rejects a malformed secret without throwing", () => {
    expect(verifyTotp("not!base32!", "123456")).toBe(false);
  });

  it("builds a scannable otpauth URI", () => {
    const uri = totpUri("JBSWY3DPEHPK3PXP", "mehmet@sahin-doener.de");
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain("issuer=Belegbox");
    expect(uri).toContain("digits=6");
  });

  it("marks the roles PRD § 10.3 requires MFA for", () => {
    expect(requiresMfa("owner")).toBe(true);
    expect(requiresMfa("accountant")).toBe(true);
    expect(requiresMfa("viewer")).toBe(false);
  });
});

describe("login", () => {
  const candidate = async (over: Partial<LoginCandidate> = {}): Promise<LoginCandidate> => ({
    userId: "u1",
    tenantId: "t1",
    passwordHash: await hashPassword(PASSWORD),
    totpSecret: null,
    role: "viewer",
    locale: "de",
    mfaEnabled: false,
    lockedUntil: null,
    ...over,
  });

  it("accepts the right password", async () => {
    const result = await attemptLogin(await candidate(), { password: PASSWORD });
    expect(result).toMatchObject({ ok: true, userId: "u1", tenantId: "t1" });
  });

  it("rejects the wrong password", async () => {
    const result = await attemptLogin(await candidate(), { password: "not it at all" });
    expect(result).toMatchObject({ ok: false, reason: "invalid_credentials" });
  });

  /**
   * An unknown address and a wrong password must be indistinguishable, in both
   * the response and the timing. For a tax product, an enumeration oracle tells
   * an attacker which companies are customers.
   */
  it("gives an unknown account the same answer as a wrong password", async () => {
    const unknown = await attemptLogin(undefined, { password: PASSWORD });
    const wrong = await attemptLogin(await candidate(), { password: "wrong password here" });
    expect(unknown.ok).toBe(false);
    expect(wrong.ok).toBe(false);
    if (!unknown.ok && !wrong.ok) expect(unknown.reason).toBe(wrong.reason);
  });

  it("spends comparable time on an unknown account", async () => {
    const time = async (fn: () => Promise<unknown>) => {
      const start = process.hrtime.bigint();
      await fn();
      return Number(process.hrtime.bigint() - start) / 1e6;
    };
    const known = await candidate();
    const unknownMs = await time(() => attemptLogin(undefined, { password: PASSWORD }));
    const knownMs = await time(() => attemptLogin(known, { password: "wrong password here" }));
    // Both run a full scrypt. Generous bound: this asserts the dummy hash is
    // actually being verified, not that the machine is quiet.
    expect(unknownMs).toBeGreaterThan(knownMs / 5);
  });

  it("refuses an account with no password set", async () => {
    const result = await attemptLogin(await candidate({ passwordHash: null }), {
      password: PASSWORD,
    });
    expect(result).toMatchObject({ ok: false, reason: "invalid_credentials" });
  });

  // Checked after the password, so lockout is not observable to someone who
  // does not already have the password.
  it("refuses a locked account only once the password is right", async () => {
    const locked = await candidate({ lockedUntil: new Date(Date.now() + 60_000) });

    expect(await attemptLogin(locked, { password: PASSWORD })).toMatchObject({
      ok: false,
      reason: "locked",
    });
    expect(await attemptLogin(locked, { password: "wrong password here" })).toMatchObject({
      reason: "invalid_credentials",
    });
  });

  it("lets an expired lock through", async () => {
    const result = await attemptLogin(
      await candidate({ lockedUntil: new Date(Date.now() - 60_000) }),
      { password: PASSWORD },
    );
    expect(result.ok).toBe(true);
  });

  describe("second factor", () => {
    const secret = generateTotpSecret();
    const now = new Date("2026-09-01T10:00:00Z");
    const code = () => totpCode(secret, Math.floor(now.getTime() / 1000 / 30));

    it("asks for a code only after the password is right", async () => {
      const user = await candidate({ mfaEnabled: true, totpSecret: secret });

      expect(await attemptLogin(user, { password: PASSWORD, now })).toMatchObject({
        reason: "mfa_required",
      });
      // Wrong password reveals nothing about the second factor.
      expect(await attemptLogin(user, { password: "wrong password here", now })).toMatchObject({
        reason: "invalid_credentials",
      });
    });

    it("accepts a valid code", async () => {
      const user = await candidate({ mfaEnabled: true, totpSecret: secret });
      const result = await attemptLogin(user, { password: PASSWORD, totpCode: code(), now });
      expect(result.ok).toBe(true);
    });

    it("rejects a wrong code", async () => {
      const user = await candidate({ mfaEnabled: true, totpSecret: secret });
      expect(
        await attemptLogin(user, { password: PASSWORD, totpCode: "000000", now }),
      ).toMatchObject({ reason: "mfa_invalid" });
    });

    it("refuses a half-finished enrolment rather than treating it as satisfied", async () => {
      const user = await candidate({ mfaEnabled: true, totpSecret: null });
      expect(await attemptLogin(user, { password: PASSWORD, now })).toMatchObject({
        reason: "mfa_enrollment_required",
      });
    });

    /**
     * § 10.3 makes MFA mandatory for owner and accountant. A requirement that
     * yields when inconvenient is not a requirement.
     */
    it("refuses an owner with no secret at all", async () => {
      const owner = await candidate({ role: "owner", mfaEnabled: false, totpSecret: null });
      expect(await attemptLogin(owner, { password: PASSWORD, now })).toMatchObject({
        ok: false,
        reason: "mfa_enrollment_required",
      });
    });

    /**
     * Setup issues a secret but cannot confirm it, so the flag is still off.
     * Completing enrolment on first sign-in avoids the alternative: an owner
     * account created by setup that its owner cannot use.
     */
    it("completes a pending enrolment on the first sign-in", async () => {
      const owner = await candidate({ role: "owner", mfaEnabled: false, totpSecret: secret });

      expect(await attemptLogin(owner, { password: PASSWORD, now })).toMatchObject({
        reason: "mfa_required",
      });
      expect(
        await attemptLogin(owner, { password: PASSWORD, totpCode: "000000", now }),
      ).toMatchObject({ reason: "mfa_invalid" });

      const result = await attemptLogin(owner, { password: PASSWORD, totpCode: code(), now });
      expect(result).toMatchObject({ ok: true, activatedMfa: true });
    });

    it("lets a viewer in without MFA", async () => {
      const viewer = await candidate({ role: "viewer", mfaEnabled: false });
      expect((await attemptLogin(viewer, { password: PASSWORD, now })).ok).toBe(true);
    });

    it("passes replay protection through to the verifier", async () => {
      const user = await candidate({ mfaEnabled: true, totpSecret: secret });
      const consume = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);

      expect(
        (await attemptLogin(user, { password: PASSWORD, totpCode: code(), now, consumeTotp: consume })).ok,
      ).toBe(true);
      expect(
        await attemptLogin(user, { password: PASSWORD, totpCode: code(), now, consumeTotp: consume }),
      ).toMatchObject({ reason: "mfa_invalid" });
    });
  });

  it("counts only real guesses towards lockout", () => {
    expect(countsAsFailure("invalid_credentials")).toBe(true);
    expect(countsAsFailure("mfa_invalid")).toBe(true);
    // A missing enrolment is a configuration problem; counting it would let one
    // misconfigured owner lock themselves out by reloading the page.
    expect(countsAsFailure("mfa_enrollment_required")).toBe(false);
    expect(countsAsFailure("mfa_required")).toBe(false);
  });
});

describe("recovery codes", () => {
  it("reads back the way someone types them under stress", () => {
    // Off a screen, by hand, having just lost a phone: lower case, hyphens
    // dropped, spaces added. All three are the same code.
    const code = generateRecoveryCode();
    const mangled = code.toLowerCase().replace(/-/g, " ");
    expect(hashRecoveryCode(mangled)).toBe(hashRecoveryCode(code));
  });

  it("leaves out the characters that get misread", () => {
    // No O against 0, no I or L against 1.
    const codes = generateRecoveryCodes(40).join("");
    expect(codes).not.toMatch(/[OIL01]/);
  });

  it("does not repeat itself", () => {
    const codes = generateRecoveryCodes(50);
    expect(new Set(codes).size).toBe(50);
  });

  it("is long enough to be worth hashing", () => {
    // 20 characters from a 31-letter alphabet is about 99 bits.
    expect(generateRecoveryCode().replace(/-/g, "")).toHaveLength(20);
  });
});

describe("signing in with a recovery code", () => {
  const candidate = {
    userId: "u1",
    tenantId: "t1",
    passwordHash: "",
    totpSecret: "JBSWY3DPEHPK3PXP",
    role: "owner",
    locale: "de",
    mfaEnabled: true,
    lockedUntil: null,
  };

  it("stands in for the authenticator", async () => {
    const hashed = await hashPassword(PASSWORD);
    const outcome = await attemptLogin(
      { ...candidate, passwordHash: hashed },
      { password: PASSWORD, recoveryCode: "ABCDE-FGHJK", consumeRecoveryCode: async () => true },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.usedRecoveryCode).toBe(true);
  });

  it("is refused once the database says it is spent", async () => {
    const hashed = await hashPassword(PASSWORD);
    const outcome = await attemptLogin(
      { ...candidate, passwordHash: hashed },
      { password: PASSWORD, recoveryCode: "ABCDE-FGHJK", consumeRecoveryCode: async () => false },
    );
    expect(outcome).toMatchObject({ ok: false, reason: "mfa_invalid" });
  });

  it("is never reached on a wrong password", async () => {
    // The code must not be spent by someone who does not have the password.
    let asked = false;
    const outcome = await attemptLogin(
      { ...candidate, passwordHash: await hashPassword(PASSWORD) },
      {
        password: "wrong password entirely",
        recoveryCode: "ABCDE-FGHJK",
        consumeRecoveryCode: async () => {
          asked = true;
          return true;
        },
      },
    );
    expect(outcome).toMatchObject({ ok: false, reason: "invalid_credentials" });
    expect(asked).toBe(false);
  });
});
