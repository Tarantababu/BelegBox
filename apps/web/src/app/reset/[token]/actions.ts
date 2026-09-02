"use server";

import { redirect } from "next/navigation";
import { confirmPasswordReset } from "../../../lib/api";
import type { Key } from "../../../lib/i18n";

export interface ConfirmState {
  errorKey?: Key;
  mfaRequired?: boolean;
}

const MESSAGE_KEY: Record<string, Key> = {
  invalid_or_expired_token: "err.reset.linkSpent",
  mfa_invalid: "err.mfa.invalid_code",
  mfa_enrollment_required: "err.mfa_enrollment_required",
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
    return { errorKey: "err.passwordTooShort" };
  }
  if (password !== repeat) {
    return { errorKey: "err.passwordMismatch" };
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
      errorKey: MESSAGE_KEY[result.error ?? ""] ?? "err.reset.linkSpent",
      ...(result.error === "mfa_invalid" ? { mfaRequired: true } : {}),
    };
  }

  redirect("/login?reset=done");
}
