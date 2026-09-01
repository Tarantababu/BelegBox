"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import {
  beginMfa,
  confirmMfa,
  createApiKey,
  revokeApiKey,
  SESSION_COOKIE,
} from "../../lib/api";

export interface MfaState {
  error?: string;
  /** The secret to scan. Held in the component, never in a URL. */
  secret?: string;
  uri?: string;
  /** Shown once, after a code has proved the new secret works. */
  recoveryCodes?: string[];
}

const MFA_MESSAGES: Record<string, string> = {
  invalid_code: "Der Code stimmt nicht. Er wechselt alle 30 Sekunden.",
  expired: "Die Einrichtung ist abgelaufen. Bitte noch einmal beginnen.",
  no_pending_secret: "Es läuft gerade keine Einrichtung. Bitte noch einmal beginnen.",
};

export async function beginMfaAction(
  _previous: MfaState,
  formData: FormData,
): Promise<MfaState> {
  const password = String(formData.get("password") ?? "");
  if (!password) return { error: "Bitte das aktuelle Passwort eingeben." };

  const result = await beginMfa(password);
  if (!result.ok) return { error: MFA_MESSAGES[result.error] ?? result.error };

  return { secret: result.secret, uri: result.uri };
}

export async function confirmMfaAction(
  previous: MfaState,
  formData: FormData,
): Promise<MfaState> {
  const code = String(formData.get("code") ?? "").trim();
  if (!code) return { ...previous, error: "Bitte den Code aus der App eingeben." };

  const result = await confirmMfa(code);
  if (!result.ok) {
    // The pending secret survives a wrong code, so the user stays on the scan
    // step rather than starting over on a typo.
    return { ...previous, error: MFA_MESSAGES[result.error] ?? result.error };
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

export interface KeyState {
  error?: string;
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

  if (!name) return { error: "Bitte einen Namen vergeben." };
  if (!password) return { error: "Bitte das aktuelle Passwort eingeben." };

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
