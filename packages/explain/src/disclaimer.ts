import type { Locale } from "./types.js";

/**
 * The disclaimer belongs to the renderer, not to any template.
 *
 * PRD § 13.2 requires it on every explanation. Making it a template field would
 * mean an author could soften it, shorten it, or leave it out of one locale -
 * and the one it went missing from would be the one nobody reviewed. It is a
 * constant, it is appended by the renderer, and no template can override it:
 * the loader rejects a template that even declares the field.
 *
 * The wording tracks § 13.2's own line - this describes the document and the
 * statute, it does not assess the reader's tax position.
 */
export const DISCLAIMERS: Record<Locale, string> = {
  de: "Das ist eine Beschreibung der Rechnungsdaten und der einschlägigen Rechtsnorm, keine steuerliche Beratung. Bitte kläre das mit deiner Steuerberatung.",
  tr: "Bu açıklama, fatura verilerinin ve ilgili kanun maddesinin tarifidir; vergi danışmanlığı değildir. Lütfen mali müşavirinle teyit et.",
};

export function disclaimerFor(locale: Locale): string {
  return DISCLAIMERS[locale];
}
