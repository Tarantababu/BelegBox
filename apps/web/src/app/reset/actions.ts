"use server";

import { requestPasswordReset } from "../../lib/api";
import type { Key } from "../../lib/i18n";

export interface RequestState {
  done?: boolean;
  /** Development only: the API returns the link when configured to. */
  link?: string;
  errorKey?: Key;
}

/**
 * Asks for a reset link.
 *
 * Reports the same thing whether or not the address exists. The page never
 * learns which, so neither does anyone scripting it.
 */
export async function requestResetAction(
  _previous: RequestState,
  formData: FormData,
): Promise<RequestState> {
  const email = String(formData.get("email") ?? "").trim();
  if (!email.includes("@")) {
    return { errorKey: "err.emailInvalid" };
  }

  const result = await requestPasswordReset(email);
  if (!result.ok) {
    return { errorKey: "err.reset.failed" };
  }
  return { done: true, ...(result.link ? { link: result.link } : {}) };
}
