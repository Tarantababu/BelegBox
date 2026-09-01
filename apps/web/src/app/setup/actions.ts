"use server";

import { redirect } from "next/navigation";
import { createTenantAccount } from "../../lib/api";

export interface SetupState {
  error?: string;
}

/**
 * M-01. Company, credentials, sector - no card, under 90 seconds.
 *
 * Setup does not sign the user in. The owner role requires a second factor
 * (PRD § 10.3), and a session issued before that is confirmed would be a
 * session that skipped it. The enrolment secret is shown once, then the user
 * signs in with it.
 */
export async function setupAction(
  _previous: SetupState,
  formData: FormData,
): Promise<SetupState> {
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!name) return { error: "Bitte den Firmennamen eingeben." };
  if (!email.includes("@")) return { error: "Bitte eine gültige E-Mail-Adresse eingeben." };
  if (password.length < 12) {
    return { error: "Das Passwort braucht mindestens 12 Zeichen. Länge zählt mehr als Sonderzeichen." };
  }

  const taxId = String(formData.get("taxId") ?? "").trim();
  const industry = String(formData.get("industry") ?? "").trim();
  const locale = String(formData.get("locale") ?? "de").trim();

  let created: Awaited<ReturnType<typeof createTenantAccount>>;
  try {
    created = await createTenantAccount({
      name,
      email,
      password,
      ...(taxId ? { taxId } : {}),
      ...(industry ? { industry } : {}),
      locale,
    });
  } catch (err) {
    return { error: (err as Error).message };
  }

  // The secret travels in the URL of a one-time page rather than a cookie or
  // the database: it is shown once and never retrievable afterwards.
  const params = new URLSearchParams({
    address: created.inboxAddress,
    secret: created.mfa.secret,
    uri: created.mfa.uri,
    email,
  });
  redirect(`/setup/done?${params.toString()}`);
}
