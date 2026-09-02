import { cookies, headers } from "next/headers";
import { getTenant } from "../api";
import { LANGUAGE_COOKIE, isLanguage, negotiateLanguage, uiFor, type Ui } from "./index";

/**
 * Which language this request is rendered in.
 *
 * Three sources, in the order of how much they know about the reader:
 *
 *   1. `users.locale`, carried on the session and delivered with /v1/tenant.
 *      The record of a deliberate choice, and the only one that follows a
 *      person to a new device.
 *   2. The cookie. What login, password reset and setup have to go on, because
 *      there is no session yet on any of them - and what keeps the choice from
 *      snapping back to German the moment someone signs out.
 *   3. Accept-Language. For the very first visit, where the two above are
 *      empty. A Romanian browser lands on a Romanian setup form without anyone
 *      hunting for a picker first, which is most of the point of this list.
 *
 * German last, because it is the fallback, not a preference anyone expressed.
 */
export async function resolveUi(): Promise<Ui> {
  const tenant = await getTenant();
  if (tenant && isLanguage(tenant.language)) return uiFor(tenant.language);

  const cookieValue = (await cookies()).get(LANGUAGE_COOKIE)?.value;
  if (isLanguage(cookieValue)) return uiFor(cookieValue);

  return uiFor(negotiateLanguage((await headers()).get("accept-language")));
}

/**
 * The same, for the screens that have no session by definition. Skips the
 * /v1/tenant call rather than making one that is known to answer 401.
 */
export async function resolvePublicUi(): Promise<Ui> {
  const cookieValue = (await cookies()).get(LANGUAGE_COOKIE)?.value;
  if (isLanguage(cookieValue)) return uiFor(cookieValue);

  return uiFor(negotiateLanguage((await headers()).get("accept-language")));
}
