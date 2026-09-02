"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { login, SESSION_COOKIE } from "../../lib/api";
import type { Key } from "../../lib/i18n";

export interface LoginState {
  /** A dictionary key, rendered by the form in the reader's language. */
  errorKey?: Key;
  /** Set once the password was right and a code is still needed. */
  mfaRequired?: boolean;
}

/**
 * The API's codes, mapped to wording.
 *
 * These were German literals, which meant a Polish speaker who mistyped their
 * password was told so in German - on the one screen they cannot read their way
 * past. The words are chosen by the component now, which knows the language.
 */
const MESSAGE_KEY: Record<string, Key> = {
  invalid_credentials: "err.credentials",
  mfa_invalid: "err.mfa.invalid_code",
  mfa_enrollment_required: "err.mfa_enrollment_required",
};

export async function loginAction(
  _previous: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const totpCode = String(formData.get("totpCode") ?? "").trim();

  if (!email || !password) {
    return { errorKey: "err.needEmailPassword" };
  }

  const result = await login({
    email,
    password,
    ...(totpCode ? { totpCode } : {}),
  });

  if (!result.ok) {
    // Only asked for once the password was already correct, so the form never
    // reveals whether an address exists.
    if (result.error === "mfa_required") return { mfaRequired: true };
    return {
      errorKey: MESSAGE_KEY[result.error ?? ""] ?? "err.credentials",
      ...(result.error === "mfa_invalid" ? { mfaRequired: true } : {}),
    };
  }

  // The API minted the session; forward its cookie to the browser.
  const token = /belegbox_session=([^;]+)/.exec(result.setCookie ?? "")?.[1];
  if (!token) return { errorKey: "err.credentials" };

  (await cookies()).set(SESSION_COOKIE, decodeURIComponent(token), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });

  redirect("/inbox");
}
