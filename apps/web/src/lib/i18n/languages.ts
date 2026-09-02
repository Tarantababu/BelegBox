/**
 * The languages Belegbox speaks.
 *
 * Chosen by what people in Germany actually speak at home, because that is who
 * runs the businesses this product is for. Ranked roughly by number of speakers
 * (Mikrozensus "überwiegend gesprochene Sprache im Haushalt" plus the migration
 * statistics), with English added for a different reason: it is the language a
 * founder from outside these ten reaches for, and it is the only sensible
 * second choice for someone whose own language is not here yet.
 *
 * Two things this list is deliberately NOT:
 *
 *   - It is not the set of languages the *explanations* come in. Those are
 *     German and Turkish, because those are the two a lawyer has been asked to
 *     review (Ek A). § 2-5 StBerG make an explanation of a tax rule something
 *     you may not improvise, and running legal wording through a translator
 *     would be improvising it in nine new languages at once. `hasExplanations`
 *     below is the honest flag; the account screen says so out loud.
 *
 *   - It is not final. Adding one means writing a dictionary and a migration -
 *     see 0012_languages.sql, which holds the same list as a CHECK constraint
 *     so an unsupported code cannot reach the database. The next candidates by
 *     speaker count are Bosnian/Croatian/Serbian, Vietnamese and Persian; the
 *     first of those is three standard languages sharing a dictionary's worth
 *     of work, which is why it is not already here.
 *
 * `dir` exists for Arabic. Nothing else in the list is right-to-left, and the
 * layout sets the attribute rather than assuming.
 */

export interface Language {
  /** ISO 639-1. Also what goes in `users.locale` and the html lang attribute. */
  code: string;
  /** The name of the language *in* that language. Never a translated name: a
   *  Ukrainian speaker looking for their language scans for "Українська", and a
   *  list that says "Ukrainisch" to someone who does not read German is a list
   *  they cannot use. */
  endonym: string;
  /** For the German-speaking admin reading logs and the account screen. */
  german: string;
  dir: "ltr" | "rtl";
  /** Whether finding explanations exist in this language, or fall back to German. */
  hasExplanations: boolean;
}

export const LANGUAGES: readonly Language[] = [
  { code: "de", endonym: "Deutsch",    german: "Deutsch",     dir: "ltr", hasExplanations: true },
  { code: "tr", endonym: "Türkçe",     german: "Türkisch",    dir: "ltr", hasExplanations: true },
  { code: "en", endonym: "English",    german: "Englisch",    dir: "ltr", hasExplanations: false },
  { code: "ru", endonym: "Русский",    german: "Russisch",    dir: "ltr", hasExplanations: false },
  { code: "uk", endonym: "Українська", german: "Ukrainisch",  dir: "ltr", hasExplanations: false },
  { code: "ar", endonym: "العربية",     german: "Arabisch",    dir: "rtl", hasExplanations: false },
  { code: "pl", endonym: "Polski",     german: "Polnisch",    dir: "ltr", hasExplanations: false },
  { code: "ro", endonym: "Română",     german: "Rumänisch",   dir: "ltr", hasExplanations: false },
  { code: "it", endonym: "Italiano",   german: "Italienisch", dir: "ltr", hasExplanations: false },
  { code: "el", endonym: "Ελληνικά",   german: "Griechisch",  dir: "ltr", hasExplanations: false },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]["code"];

export const DEFAULT_LANGUAGE = "de";

/** The cookie that carries the choice to screens with no session - login,
 *  password reset, the setup form. Not a credential and not authoritative:
 *  `users.locale` is the record, this is only what to render before we know
 *  who is asking. */
export const LANGUAGE_COOKIE = "belegbox_lang";

const BY_CODE = new Map(LANGUAGES.map((language) => [language.code, language]));

export function isLanguage(code: string | undefined | null): boolean {
  return code !== undefined && code !== null && BY_CODE.has(code);
}

export function languageFor(code: string | undefined | null): Language {
  return (code ? BY_CODE.get(code) : undefined) ?? (BY_CODE.get(DEFAULT_LANGUAGE) as Language);
}

/**
 * Which language a finding's explanation is written in, given the interface
 * language. Not a translation - a fallback to the reviewed text.
 */
export function explanationLanguage(code: string | undefined | null): "de" | "tr" {
  return code === "tr" ? "tr" : "de";
}

/**
 * Best match for an Accept-Language header, for the screens that come before a
 * session exists.
 *
 * Quality values are honoured, region subtags are dropped ("de-AT" is German),
 * and anything unknown is skipped rather than guessed at. Returns undefined
 * when the header offers nothing we speak, so the caller can fall back rather
 * than being handed a default it cannot distinguish from a real match.
 */
export function negotiateLanguage(header: string | undefined | null): string | undefined {
  if (!header) return undefined;

  const ranked = header
    .split(",")
    .map((part) => {
      const [tag = "", ...rest] = part.trim().split(";");
      const q = rest
        .map((p) => /^\s*q=([0-9.]+)$/.exec(p))
        .find((m) => m !== null);
      return { tag: (tag.split("-")[0] ?? "").toLowerCase(), q: q ? Number(q[1]) : 1 };
    })
    .filter((entry) => entry.tag !== "" && !Number.isNaN(entry.q) && entry.q > 0)
    .sort((a, b) => b.q - a.q);

  return ranked.find((entry) => BY_CODE.has(entry.tag))?.tag;
}
