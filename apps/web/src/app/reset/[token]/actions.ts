"use server";

import { redirect } from "next/navigation";
import { confirmPasswordReset } from "../../../lib/api";

export interface ConfirmState {
  error?: string;
  mfaRequired?: boolean;
}

const MESSAGES: Record<string, string> = {
  invalid_or_expired_token:
    "Dieser Link ist abgelaufen oder wurde schon benutzt. Fordere einen neuen an.",
  mfa_invalid: "Der Code stimmt nicht. Er wechselt alle 30 Sekunden.",
  mfa_enrollment_required:
    "Für dieses Konto ist eine Zwei-Faktor-Anmeldung hinterlegt, aber nicht fertig eingerichtet. Bitte wende dich an den Inhaber des Kontos.",
};

export async function confirmResetAction(
  _previous: ConfirmState,
  formData: FormData,
): Promise<ConfirmState> {
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  const repeat = String(formData.get("repeat") ?? "");
  const totpCode = String(formData.get("totpCode") ?? "").trim();

  if (password.length < 12) {
    return { error: "Das Passwort braucht mindestens 12 Zeichen." };
  }
  if (password !== repeat) {
    return { error: "Die beiden Passwörter stimmen nicht überein." };
  }

  const result = await confirmPasswordReset({
    token,
    password,
    ...(totpCode ? { totpCode } : {}),
  });

  if (!result.ok) {
    // Asked for only after the link itself checked out, so the form never
    // reveals whether a token was valid before the code was right.
    if (result.error === "mfa_required") return { mfaRequired: true };
    return {
      error: MESSAGES[result.error ?? ""] ?? MESSAGES["invalid_or_expired_token"],
      ...(result.error === "mfa_invalid" ? { mfaRequired: true } : {}),
    };
  }

  redirect("/login?reset=done");
}
