import { ar } from "./ar";
import { de, type Dict, type Key } from "./de";
import { el } from "./el";
import { en } from "./en";
import { it } from "./it";
import { languageFor, DEFAULT_LANGUAGE } from "./languages";
import { pl } from "./pl";
import { ro } from "./ro";
import { ru } from "./ru";
import { tr } from "./tr";
import { uk } from "./uk";

export type { Dict, Key } from "./de";
export {
  DEFAULT_LANGUAGE,
  LANGUAGES,
  LANGUAGE_COOKIE,
  explanationLanguage,
  isLanguage,
  languageFor,
  negotiateLanguage,
  type Language,
} from "./languages";

const DICTS: Record<string, Dict> = { de, tr, en, ru, uk, ar, pl, ro, it, el };

export function dictFor(code: string | undefined | null): Dict {
  return (code ? DICTS[code] : undefined) ?? (DICTS[DEFAULT_LANGUAGE] as Dict);
}

export type Translate = (key: Key, params?: Record<string, string | number>) => string;

/**
 * Binds a dictionary to a `t(key, params)`.
 *
 * A missing placeholder is left standing as `{name}` rather than replaced with
 * "undefined": a visible `{amount}` in a sentence is a bug report, while
 * "undefined €" is a number a user might believe.
 */
export function translator(dict: Dict): Translate {
  return (key, params) => {
    const text = dict[key];
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
      name in params ? String(params[name]) : whole,
    );
  };
}

/** Everything a screen needs to render in one language. */
export interface Ui {
  /** ISO 639-1 code, for the html lang attribute. */
  lang: string;
  dir: "ltr" | "rtl";
  dict: Dict;
  t: Translate;
}

export function uiFor(code: string | undefined | null): Ui {
  const language = languageFor(code);
  const dict = dictFor(language.code);
  return { lang: language.code, dir: language.dir, dict, t: translator(dict) };
}

/**
 * Locale for `toLocaleDateString` and friends.
 *
 * Deliberately NOT the interface language. Amounts and dates on these screens
 * are read next to a German invoice, typed into DATEV, and quoted to a
 * Steuerberatung - `1.234,56 €` and `31.08.2026`. Rendering `$1,234.56` or
 * `8/31/2026` because someone reads the buttons in English would make the
 * screen disagree with the document it is describing.
 */
export const FORMAT_LOCALE = "de-DE";
