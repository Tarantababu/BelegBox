export type Locale = "de" | "tr";

export const LOCALES: readonly Locale[] = ["de", "tr"];

/**
 * One locale's text for one template.
 *
 * Three fields, and the shape is the point. § 13.2 draws the line between
 * describing and advising:
 *
 *   observation - what this document says. A description of data on the page.
 *   legal_basis - what the law says in general. A statement about the statute.
 *   next_step   - an optional business action, never a tax conclusion.
 *
 * There is deliberately no field for "what you should do about your tax
 * position". A template cannot express it, so no template can accidentally
 * contain it, and the lint refuses the phrasings that try.
 *
 * The disclaimer is not here either: it belongs to the renderer, so an author
 * cannot weaken or omit it. See disclaimer.ts.
 */
export interface LocaleText {
  observation: string;
  legal_basis: string;
  next_step?: string;
}

/**
 * Where a finding's authority comes from.
 *
 * Most explanations rest on a statute or a published standard. D-008 and D-009
 * do not: "the IBAN is registered in another country" is Belegbox's own fraud
 * heuristic, and no paragraph of the UStG says it. Declaring that makes the
 * distinction machine-checkable - a signal may not cite law, and a legal rule
 * must. Dressing a heuristic up as law would be the more damaging mistake.
 */
export type BasisKind = "statute" | "standard" | "belegbox_signal";

export interface ExplainTemplate {
  key: string;
  version: number;
  basis_kind: BasisKind;
  /**
   * Set only after a lawyer has reviewed the wording (Ek A). Unapproved
   * templates render in development and are refused in production - the review
   * is a launch gate, not a nice-to-have.
   */
  approved: boolean;
  approved_by?: string;
  approved_at?: string;
  /** Parameters the text needs. A render missing one of these fails loudly. */
  required_params?: string[];
  locales: Record<Locale, LocaleText>;
}

export interface RenderedExplanation {
  key: string;
  version: number;
  locale: Locale;
  observation: string;
  legalBasis: string;
  nextStep?: string;
  /** Always present, always the renderer's own words. */
  disclaimer: string;
  /**
   * True when no template existed and the raw validator output was shown
   * instead. An honest "we have not written this one yet" beats an invented
   * explanation of a tax rule.
   */
  fallback: boolean;
  approved: boolean;
}

export class TemplateError extends Error {
  constructor(
    message: string,
    readonly key?: string,
  ) {
    super(key ? `${key}: ${message}` : message);
    this.name = "TemplateError";
  }
}
