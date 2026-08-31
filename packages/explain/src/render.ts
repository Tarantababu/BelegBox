import { disclaimerFor } from "./disclaimer.js";
import { formatTemplate, type ParamValue } from "./format.js";
import {
  TemplateError,
  type ExplainTemplate,
  type Locale,
  type RenderedExplanation,
} from "./types.js";

export interface Registry {
  get(key: string): ExplainTemplate | undefined;
  keys(): string[];
}

export class TemplateRegistry implements Registry {
  private readonly templates = new Map<string, ExplainTemplate>();

  add(template: ExplainTemplate): void {
    if (this.templates.has(template.key)) {
      throw new TemplateError("Duplicate template key.", template.key);
    }
    this.templates.set(template.key, template);
  }

  get(key: string): ExplainTemplate | undefined {
    return this.templates.get(key);
  }

  keys(): string[] {
    return [...this.templates.keys()].sort();
  }

  get size(): number {
    return this.templates.size;
  }
}

export interface RenderOptions {
  /**
   * Production refuses to render an unapproved template. The lawyer's review of
   * every explanation is a launch gate (Ek A), and a build that can ship an
   * unreviewed one makes the gate decorative.
   */
  allowUnapproved?: boolean;
  /**
   * Raw validator output, shown when no template exists for the key. An honest
   * "we have not written this one" is better than an invented explanation of a
   * tax rule.
   */
  rawMessage?: string;
}

export class MissingTemplateError extends TemplateError {
  constructor(key: string) {
    super("No template, and no raw message to fall back to.", key);
    this.name = "MissingTemplateError";
  }
}

/**
 * Renders one explanation.
 *
 * Pure: no network, no LLM, no clock. The same key, locale and parameters
 * produce the same three sentences today and in 2033, which is what makes a
 * stored verdict re-derivable (R-2) and what keeps a hallucination out of a tax
 * explanation. An LLM's part in this is drafting the YAML, before review -
 * never rendering at request time.
 */
export function renderExplanation(
  registry: Registry,
  key: string,
  locale: Locale,
  params: Record<string, ParamValue> = {},
  options: RenderOptions = {},
): RenderedExplanation {
  const template = registry.get(key);

  if (!template) {
    if (options.rawMessage === undefined) throw new MissingTemplateError(key);
    return {
      key,
      version: 0,
      locale,
      observation: options.rawMessage,
      legalBasis: "",
      disclaimer: disclaimerFor(locale),
      fallback: true,
      approved: false,
    };
  }

  if (!template.approved && !options.allowUnapproved) {
    throw new TemplateError(
      "Template is not approved for release. A lawyer reviews every explanation before it reaches a user (Ek A).",
      key,
    );
  }

  const text = template.locales[locale];
  const observation = formatTemplate(text.observation, params, locale);
  const legalBasis = formatTemplate(text.legal_basis, params, locale);
  const nextStep = text.next_step
    ? formatTemplate(text.next_step, params, locale)
    : undefined;

  const missing = [
    ...new Set([...observation.missing, ...legalBasis.missing, ...(nextStep?.missing ?? [])]),
  ];
  if (missing.length > 0) {
    // Rendering "{vat_gap}" to a user reads as a broken product and, worse,
    // leaves them with a finding they cannot check.
    throw new TemplateError(
      `Missing parameters: ${missing.join(", ")}. The finding that produced this key must supply them.`,
      key,
    );
  }

  return {
    key,
    version: template.version,
    locale,
    observation: observation.text,
    legalBasis: legalBasis.text,
    ...(nextStep ? { nextStep: nextStep.text } : {}),
    disclaimer: disclaimerFor(locale),
    fallback: false,
    approved: template.approved,
  };
}

/**
 * Renders both languages at once.
 *
 * The document detail screen shows the user's language and German together, so
 * the German text can be forwarded to a supplier or a Steuerberater without the
 * user having to translate their own finding (PRD § 5.4).
 */
export function renderBoth(
  registry: Registry,
  key: string,
  primary: Locale,
  params: Record<string, ParamValue> = {},
  options: RenderOptions = {},
): { primary: RenderedExplanation; german: RenderedExplanation } {
  return {
    primary: renderExplanation(registry, key, primary, params, options),
    german: renderExplanation(registry, key, "de", params, options),
  };
}
