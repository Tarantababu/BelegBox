"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { LANGUAGE_COOKIE, isLanguage } from "../lib/i18n";

/** A year. Long enough that nobody picks their language twice on one device. */
const MAX_AGE = 60 * 60 * 24 * 365;

export async function writeLanguageCookie(language: string): Promise<void> {
  (await cookies()).set(LANGUAGE_COOKIE, language, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
    secure: process.env.NODE_ENV === "production",
  });
}

/**
 * The language picker on the screens that have no session: login, password
 * reset, setup.
 *
 * Accept-Language gets most people to the right language without anyone
 * touching this. It exists for the rest - a shared machine in the Betrieb, a
 * browser installed in German by whoever set it up, a phone bought secondhand.
 * Without it, the reader whose browser guesses wrong has to sign in first, and
 * signing in is exactly what they cannot read their way through.
 *
 * `next` decides where to come back to, and is checked to be a path on this
 * site: a form field that turns into a redirect target is an open redirect if
 * it is taken at face value.
 */
export async function switchLanguageAction(formData: FormData): Promise<void> {
  const language = String(formData.get("language") ?? "");
  if (isLanguage(language)) await writeLanguageCookie(language);

  const next = String(formData.get("next") ?? "/login");
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/login");
}
