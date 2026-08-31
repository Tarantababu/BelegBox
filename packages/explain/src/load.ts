import { parse as parseYaml } from "yaml";
import { templatePlaceholders } from "./format.js";
import { describeProblems, lintText } from "./lint.js";
import {
  LOCALES,
  TemplateError,
  type BasisKind,
  type ExplainTemplate,
  type Locale,
  type LocaleText,
} from "./types.js";

const BASIS_KINDS: BasisKind[] = ["statute", "standard", "belegbox_signal"];
const CITATION = /§|EN 16931|UNTDID|ZUGFeRD|Factur-X|BR-|E-Rechnungsverordnung/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadLocaleText(raw: unknown, key: string, locale: Locale): LocaleText {
  if (!isRecord(raw)) {
    throw new TemplateError(`Locale "${locale}" must be a mapping.`, key);
  }

  // A template that declares its own disclaimer is refused outright. The
  // disclaimer is the renderer's, precisely so it cannot be weakened here.
  if ("disclaimer" in raw) {
    throw new TemplateError(
      `Locale "${locale}" declares a disclaimer. The disclaimer is fixed by the renderer and cannot be set per template.`,
      key,
    );
  }

  const text: Partial<LocaleText> = {};
  for (const field of ["observation", "legal_basis"] as const) {
    const value = raw[field];
    if (typeof value !== "string" || value.trim() === "") {
      throw new TemplateError(`Locale "${locale}" needs a non-empty ${field}.`, key);
    }
    text[field] = value.trim();
  }
  if (raw["next_step"] !== undefined) {
    if (typeof raw["next_step"] !== "string") {
      throw new TemplateError(`Locale "${locale}" next_step must be a string.`, key);
    }
    text.next_step = raw["next_step"].trim();
  }

  const problems = [
    ...lintText(text.observation as string, locale, "observation"),
    ...lintText(text.legal_basis as string, locale, "legal_basis"),
    ...(text.next_step ? lintText(text.next_step, locale, "next_step") : []),
  ];
  if (problems.length > 0) {
    throw new TemplateError(
      `Wording crosses from describing into advising (StBerG § 2-5): ${describeProblems(problems)}`,
      key,
    );
  }

  return text as LocaleText;
}

/**
 * Parses and validates one template.
 *
 * Everything checkable without a document is checked here: both locales
 * present, required parameters actually used, placeholders declared, and the
 * wording inside the line § 13.2 draws.
 */
export function loadTemplate(yaml: string): ExplainTemplate {
  let doc: unknown;
  try {
    doc = parseYaml(yaml);
  } catch (err) {
    throw new TemplateError(`Invalid YAML: ${(err as Error).message}`);
  }
  if (!isRecord(doc)) throw new TemplateError("A template must be a mapping.");

  const key = doc["key"];
  // Hyphens are allowed because L2 keys are derived from EN 16931 rule codes:
  // BR-CO-15 becomes l2.br-co-15. Rejecting them would leave every Schematron
  // finding without a template.
  if (typeof key !== "string" || !/^[a-z0-9]+(\.[a-z0-9_-]+)+$/i.test(key)) {
    throw new TemplateError(`A template needs a dotted key, got "${String(key)}".`);
  }

  const version = doc["version"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new TemplateError("A template needs an integer version of 1 or more.", key);
  }

  const approved = doc["approved"];
  if (typeof approved !== "boolean") {
    throw new TemplateError("A template must state approved: true or false.", key);
  }

  const basisKind = doc["basis_kind"] ?? "statute";
  if (typeof basisKind !== "string" || !BASIS_KINDS.includes(basisKind as BasisKind)) {
    throw new TemplateError(`basis_kind must be one of ${BASIS_KINDS.join(", ")}.`, key);
  }

  const localesRaw = doc["locales"];
  if (!isRecord(localesRaw)) throw new TemplateError("A template needs locales.", key);

  const locales = {} as Record<Locale, LocaleText>;
  for (const locale of LOCALES) {
    if (!(locale in localesRaw)) {
      // A half-translated template is worse than none: the user silently gets
      // the other language for one finding and their own for the next.
      throw new TemplateError(`Missing locale "${locale}". Every template needs all of ${LOCALES.join(", ")}.`, key);
    }
    locales[locale] = loadLocaleText(localesRaw[locale], key, locale);
  }

  const required = doc["required_params"];
  if (required !== undefined && (!Array.isArray(required) || required.some((p) => typeof p !== "string"))) {
    throw new TemplateError("required_params must be a list of strings.", key);
  }
  const requiredParams = (required as string[] | undefined) ?? [];

  // Every declared parameter must be used somewhere, and every placeholder must
  // be declared. Both directions catch a rename that only got half done.
  const used = new Set<string>();
  for (const locale of LOCALES) {
    const text = locales[locale];
    for (const field of [text.observation, text.legal_basis, text.next_step ?? ""]) {
      for (const name of templatePlaceholders(field)) used.add(name);
    }
  }
  for (const name of requiredParams) {
    if (!used.has(name)) {
      throw new TemplateError(`Declared parameter "${name}" is not used in any locale.`, key);
    }
  }
  for (const name of used) {
    if (!requiredParams.includes(name)) {
      throw new TemplateError(`Placeholder "{${name}}" is used but not declared in required_params.`, key);
    }
  }

  for (const locale of LOCALES) {
    const basis = locales[locale].legal_basis;
    if (basisKind === "belegbox_signal") {
      // A heuristic must not borrow the authority of a statute. This is the
      // more damaging direction of the two.
      if (CITATION.test(basis)) {
        throw new TemplateError(
          `Locale "${locale}" cites a legal source, but basis_kind is belegbox_signal. Either cite nothing, or declare the real basis.`,
          key,
        );
      }
    } else if (!CITATION.test(basis)) {
      throw new TemplateError(
        `Locale "${locale}" states a legal basis without naming a statute or standard. An explanation with no authority behind it is an opinion.`,
        key,
      );
    }
  }

  return {
    key,
    version,
    basis_kind: basisKind as BasisKind,
    approved,
    ...(typeof doc["approved_by"] === "string" ? { approved_by: doc["approved_by"] } : {}),
    ...(typeof doc["approved_at"] === "string" ? { approved_at: doc["approved_at"] } : {}),
    ...(requiredParams.length > 0 ? { required_params: requiredParams } : {}),
    locales,
  };
}
