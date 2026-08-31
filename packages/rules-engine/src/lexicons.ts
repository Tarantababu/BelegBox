/**
 * Named word lists for `matches_lexicon`.
 *
 * Matching is substring, on a case-folded and umlaut-folded copy of the text.
 * Word boundaries would be wrong for German: the term that actually appears on
 * a supplier's invoice line is "Getränkelieferung" or "Mineralwasser", not
 * "Getränk" standing alone.
 *
 * The cost of substring matching is false positives, so entries are chosen long
 * enough to carry their own context - "bier" not "bir", "limonade" not "limo".
 * That trade is acceptable because a lexicon hit produces a finding for a human
 * to read, never a block. It is not acceptable in the other direction: these
 * lists must not be used to decide anything automatically.
 */

export const BUILTIN_LEXICONS: Record<string, string[]> = {
  /**
   * Beverages. Since 1 January 2026 food is permanently at 7 % under
   * § 12 Abs. 2 Nr. 15 UStG, but drinks stayed at 19 %, and a mixed delivery
   * invoiced entirely at 7 % under-declares VAT.
   */
  beverages_de: [
    "getraenk",
    "bier",
    "pils",
    "weizen",
    "wein",
    "sekt",
    "prosecco",
    "spirituose",
    "schnaps",
    "likoer",
    "cola",
    "limonade",
    "brause",
    "sprudel",
    "schorle",
    "saft",
    "nektar",
    "mineralwasser",
    "tafelwasser",
    "sodawasser",
    "eistee",
    "energydrink",
    "energy drink",
    "ayran",
    "sahlep",
    "salep",
  ],

  /**
   * Drinks that are NOT at 19 %. Milk and milk-based drinks with a milk share
   * over 75 % stay at 7 %, and tap water is a separate case. A rule that
   * flags beverages must exclude these or it flags a dairy delivery.
   */
  beverage_exceptions_de: [
    "milch",
    "buttermilch",
    "kefir",
    "leitungswasser",
    "trinkwasser",
  ],

  /** Building work under § 13b Abs. 2 Nr. 4 UStG, where reverse charge applies. */
  bauleistung_de: [
    "bauleistung",
    "bauarbeiten",
    "rohbau",
    "estrich",
    "putzarbeiten",
    "trockenbau",
    "elektroinstallation",
    "sanitaerinstallation",
    "heizungsinstallation",
    "dachdecker",
    "geruestbau",
    "abbrucharbeiten",
    "erdarbeiten",
    "fliesenarbeiten",
    "malerarbeiten",
  ],

  /** Reverse charge wording that must appear in BT-120 when category is AE. */
  reverse_charge_notice_de: [
    "steuerschuldnerschaft des leistungsempfaengers",
    "reverse charge",
    "13b ustg",
    "umkehr der steuerschuld",
  ],
};

/**
 * Folds a string for lexicon comparison.
 *
 * Umlauts expand the way German writes them without the diacritic: ä -> ae,
 * ß -> ss. Both sides of the comparison are folded, so the list entries are
 * written in that same expanded form ("getraenk", not "getränk").
 *
 * The expansion runs one way only. Collapsing "ae" back to "a" afterwards would
 * be symmetric and still match, but it quietly rewrites unrelated words -
 * "Steuerschuldnerschaft" loses its "ue" and becomes "sterschuldnerschaft" -
 * which makes every folded string unreadable in a debugger and invites
 * collisions between words that share nothing.
 */
export function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function matchesLexicon(
  text: string,
  terms: readonly string[],
): { matched: boolean; term?: string } {
  const folded = fold(text);
  for (const term of terms) {
    const foldedTerm = fold(term);
    if (foldedTerm && folded.includes(foldedTerm)) {
      return { matched: true, term };
    }
  }
  return { matched: false };
}

export function resolveLexicon(
  name: string,
  extra?: Record<string, string[]>,
): string[] | undefined {
  return extra?.[name] ?? BUILTIN_LEXICONS[name];
}
