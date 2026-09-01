"use server";

import { requestPasswordReset } from "../../lib/api";

export interface RequestState {
  done?: boolean;
  /** Development only: the API returns the link when configured to. */
  link?: string;
  error?: string;
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
    return { error: "Bitte eine gültige E-Mail-Adresse eingeben." };
  }

  const result = await requestPasswordReset(email);
  if (!result.ok) {
    return { error: "Das hat gerade nicht geklappt. Bitte versuch es noch einmal." };
  }
  return { done: true, ...(result.link ? { link: result.link } : {}) };
}
