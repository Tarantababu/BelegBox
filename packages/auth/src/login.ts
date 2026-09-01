import { DUMMY_HASH, verifyPassword } from "./password.js";
import { requiresMfa, verifyTotpStep } from "./totp.js";

export interface LoginCandidate {
  userId: string;
  tenantId: string;
  passwordHash: string | null;
  totpSecret: string | null;
  role: string;
  locale: string;
  mfaEnabled: boolean;
  lockedUntil: Date | null;
}

export type LoginOutcome =
  | {
      ok: true;
      userId: string;
      tenantId: string;
      role: string;
      locale: string;
      /** The caller must now set mfa_enabled: enrolment completed on this login. */
      activatedMfa?: boolean;
      /** The TOTP step that matched. The caller must claim it exactly once. */
      totpCounter?: number;
      /**
       * A recovery code was spent instead of a code from the authenticator.
       *
       * The caller should tell the user how many are left and push them towards
       * re-enrolling: someone signing in this way has lost their authenticator,
       * and silence here ends with the last code spent and no way in.
       */
      usedRecoveryCode?: boolean;
    }
  | { ok: false; reason: LoginFailure; userId?: string };

export type LoginFailure =
  | "invalid_credentials"
  | "locked"
  | "mfa_required"
  | "mfa_invalid"
  | "mfa_enrollment_required";

export interface LoginInput {
  password: string;
  totpCode?: string | undefined;
  /**
   * Offered instead of a code when the authenticator is gone.
   *
   * Single-use, and spent through `consumeRecoveryCode` - which is the port
   * that actually decides, since only the database knows whether a code is
   * still unused.
   */
  recoveryCode?: string | undefined;
  now?: Date;
  consumeTotp?: (counter: number) => boolean;
  consumeRecoveryCode?: (code: string) => Promise<boolean>;
}

/**
 * Decides one sign-in attempt.
 *
 * Pure: it takes the candidate the database found and returns a verdict. The
 * caller records the attempt and issues the session. Keeping the decision free
 * of I/O is what makes the awkward cases below testable.
 *
 * Three properties this has to preserve:
 *
 * The response never distinguishes an unknown address from a wrong password.
 * Both return `invalid_credentials`, and an unknown address is still verified
 * against a dummy hash so the timing matches - otherwise the endpoint becomes
 * an account enumeration oracle, which for a tax product tells an attacker
 * which companies use it.
 *
 * MFA is checked after the password, never before. Prompting for a code before
 * the password is right reveals that the account exists.
 *
 * An account that must have MFA and does not is refused rather than let
 * through. PRD § 10.3 makes it mandatory for owner and accountant; a
 * requirement that yields when inconvenient is not one.
 */
export async function attemptLogin(
  candidate: LoginCandidate | undefined,
  input: LoginInput,
): Promise<LoginOutcome> {
  const now = input.now ?? new Date();

  // Always spend the time, even with no account and no hash.
  const hash = candidate?.passwordHash ?? DUMMY_HASH;
  const passwordOk = await verifyPassword(input.password, hash);

  if (!candidate || !candidate.passwordHash || !passwordOk) {
    return { ok: false, reason: "invalid_credentials", ...(candidate ? { userId: candidate.userId } : {}) };
  }

  // Checked after the password so a locked account is not distinguishable from
  // a wrong one until the attacker already had the password.
  if (candidate.lockedUntil && candidate.lockedUntil > now) {
    return { ok: false, reason: "locked", userId: candidate.userId };
  }

  // A recovery code stands in for the authenticator, and is checked before the
  // TOTP branch so a user whose phone is gone is not first told their code is
  // missing. It is only reachable once the password is right, and spending it
  // is the database's decision.
  if (input.recoveryCode && input.consumeRecoveryCode) {
    const spent = await input.consumeRecoveryCode(input.recoveryCode);
    if (!spent) {
      return { ok: false, reason: "mfa_invalid", userId: candidate.userId };
    }
    return {
      ok: true,
      userId: candidate.userId,
      tenantId: candidate.tenantId,
      role: candidate.role,
      locale: candidate.locale,
      usedRecoveryCode: true,
    };
  }

  if (candidate.mfaEnabled) {
    if (!candidate.totpSecret) {
      // Flag set, no secret: the enrolment did not finish. Refusing beats
      // treating a half-configured second factor as satisfied.
      return { ok: false, reason: "mfa_enrollment_required", userId: candidate.userId };
    }
    if (!input.totpCode) {
      return { ok: false, reason: "mfa_required", userId: candidate.userId };
    }
    const result = verifyTotpStep(candidate.totpSecret, input.totpCode, {
      now,
      ...(input.consumeTotp ? { consume: input.consumeTotp } : {}),
    });
    if (!result.valid) {
      return { ok: false, reason: "mfa_invalid", userId: candidate.userId };
    }
    return {
      ok: true,
      userId: candidate.userId,
      tenantId: candidate.tenantId,
      role: candidate.role,
      locale: candidate.locale,
      ...(result.counter !== undefined ? { totpCounter: result.counter } : {}),
    };
  } else if (requiresMfa(candidate.role)) {
    // A secret without the flag is an enrolment that has not been confirmed.
    // Completing it on the first sign-in avoids the alternative: an owner
    // account created by setup that its owner cannot use.
    if (!candidate.totpSecret) {
      return { ok: false, reason: "mfa_enrollment_required", userId: candidate.userId };
    }
    if (!input.totpCode) {
      return { ok: false, reason: "mfa_required", userId: candidate.userId };
    }
    const result = verifyTotpStep(candidate.totpSecret, input.totpCode, {
      now,
      ...(input.consumeTotp ? { consume: input.consumeTotp } : {}),
    });
    if (!result.valid) {
      return { ok: false, reason: "mfa_invalid", userId: candidate.userId };
    }
    return {
      ok: true,
      userId: candidate.userId,
      tenantId: candidate.tenantId,
      role: candidate.role,
      locale: candidate.locale,
      activatedMfa: true,
      ...(result.counter !== undefined ? { totpCounter: result.counter } : {}),
    };
  }

  return {
    ok: true,
    userId: candidate.userId,
    tenantId: candidate.tenantId,
    role: candidate.role,
    locale: candidate.locale,
  };
}

/** A failure the caller should count towards lockout. */
export function countsAsFailure(reason: LoginFailure): boolean {
  // An account that simply has no second factor configured yet is a
  // configuration problem, not a guess. Counting it would let one misconfigured
  // owner lock themselves out by reloading the page.
  return reason === "invalid_credentials" || reason === "mfa_invalid";
}

/** Sessions expire; a browser left open in a shared office is a real threat. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function sessionExpiry(from = new Date()): Date {
  return new Date(from.getTime() + SESSION_TTL_MS);
}
