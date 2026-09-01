"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { login, SESSION_COOKIE } from "../../lib/api";

export interface LoginState {
  error?: string;
  /** Set once the password was right and a code is still needed. */
  mfaRequired?: boolean;
}

const MESSAGES: Record<string, string> = {
  invalid_credentials: "E-Mail-Adresse oder Passwort stimmt nicht.",
  mfa_invalid: "Der Code stimmt nicht. Er wechselt alle 30 Sekunden.",
  mfa_enrollment_required:
    "Für diese Rolle ist eine Zwei-Faktor-Anmeldung erforderlich, sie ist aber noch nicht eingerichtet. Bitte wende dich an den Inhaber des Kontos.",
};

export async function loginAction(
  _previous: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const totpCode = String(formData.get("totpCode") ?? "").trim();

  if (!email || !password) {
    return { error: "Bitte E-Mail-Adresse und Passwort eingeben." };
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
      error: MESSAGES[result.error ?? ""] ?? MESSAGES["invalid_credentials"],
      ...(result.error === "mfa_invalid" ? { mfaRequired: true } : {}),
    };
  }

  // The API minted the session; forward its cookie to the browser.
  const token = /belegbox_session=([^;]+)/.exec(result.setCookie ?? "")?.[1];
  if (!token) return { error: MESSAGES["invalid_credentials"] };

  (await cookies()).set(SESSION_COOKIE, decodeURIComponent(token), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });

  redirect("/inbox");
}
