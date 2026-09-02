"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import {
  beginMfa,
  confirmMfa,
  createApiKey,
  revokeApiKey,
  setLanguage,
  SESSION_COOKIE,
} from "../../lib/api";
import { isLanguage, type Key } from "../../lib/i18n";
import { writeLanguageCookie } from "../language";

/**
 * An error a form shows is either a key into the dictionary or, when nothing
 * covers it, the API's own code. Never a German sentence: the component renders
 * it, and the component knows the language.
 */
export interface FormError {
  errorKey?: Key;
  error?: string;
}

function errorFor(code: string): FormError {
  const key = MFA_MESSAGE_KEY[code];
  return key ? { errorKey: key } : { error: code };
}

export interface MfaState extends FormError {
  /** The secret to scan. Held in the component, never in a URL. */
  secret?: string;
  uri?: string;
  /** Shown once, after a code has proved the new secret works. */
  recoveryCodes?: string[];
}

/**
 * The API answers in machine-readable codes, which is what makes the words a
 * user reads choosable here. These used to be German string literals, so a
 * Greek interface reported its errors in German.
 *
 * A code with no key falls through to the raw code rather than to an invented
 * sentence - untranslated but true beats translated and made up.
 */
const MFA_MESSAGE_KEY: Record<string, Key> = {
  invalid_code: "err.mfa.invalid_code",
  expired: "err.mfa.expired",
  no_pending_secret: "err.mfa.no_pending_secret",
};

export async function beginMfaAction(
  _previous: MfaState,
  formData: FormData,
): Promise<MfaState> {
  const password = String(formData.get("password") ?? "");
  if (!password) return { errorKey: "err.needPassword" };

  const result = await beginMfa(password);
  if (!result.ok) return errorFor(result.error);

  return { secret: result.secret, uri: result.uri };
}

export async function confirmMfaAction(
  previous: MfaState,
  formData: FormData,
): Promise<MfaState> {
  const code = String(formData.get("code") ?? "").trim();
  if (!code) return { ...previous, errorKey: "err.needCode" };

  const result = await confirmMfa(code);
  if (!result.ok) {
    // The pending secret survives a wrong code, so the user stays on the scan
    // step rather than starting over on a typo.
    return { ...previous, ...errorFor(result.error) };
  }

  // Rotating revokes every session including this one. The API issued a
  // replacement; without carrying it over the user is signed out at the exact
  // moment they are reading codes they will not be shown again.
  if (result.cookie) {
    const value = /belegbox_session=([^;]+)/.exec(result.cookie)?.[1];
    if (value) {
      const store = await cookies();
      store.set(SESSION_COOKIE, decodeURIComponent(value), {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
      });
    }
  }

  revalidatePath("/einstellungen");
  return { recoveryCodes: result.recoveryCodes };
}

export interface KeyState extends FormError {
  /** Returned once at creation. There is no path that shows it again. */
  token?: string;
  name?: string;
}

export async function createKeyAction(
  _previous: KeyState,
  formData: FormData,
): Promise<KeyState> {
  const name = String(formData.get("name") ?? "").trim();
  const environment = String(formData.get("environment") ?? "live");
  const password = String(formData.get("password") ?? "");

  if (!name) return { errorKey: "err.needName" };
  if (!password) return { errorKey: "err.needPassword" };

  const result = await createApiKey({ name, environment, password });
  if (!result.ok) return { error: result.error };

  revalidatePath("/einstellungen");
  return { token: result.token, name: result.name };
}

export async function revokeKeyAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  if (id) await revokeApiKey(id);
  revalidatePath("/einstellungen");
}

export interface LanguageState extends FormError {
  saved?: boolean;
}

/**
 * Changes the signed-in person's interface language.
 *
 * Two writes, and the order matters. The database is the record - it follows
 * the person to a new browser and to a new device. The cookie is what login,
 * password reset and setup have to go on, since none of them has a session to
 * read the record from; without it, signing out would drop the reader back to
 * German on the very screen they need to read to sign back in.
 *
 * The cookie is written from what the API confirms, never from what was asked
 * for. A rejected language must not leave a cookie claiming it was accepted -
 * that would be a setting that appears to work everywhere except where it
 * matters.
 */
export async function changeLanguageAction(
  _previous: LanguageState,
  formData: FormData,
): Promise<LanguageState> {
  const language = String(formData.get("language") ?? "");
  if (!isLanguage(language)) return { errorKey: "err.language" };

  const result = await setLanguage(language);
  if (!result.ok) return { errorKey: "err.language" };

  await writeLanguageCookie(result.language);
  revalidatePath("/", "layout");
  return { saved: true };
}
