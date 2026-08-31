import type { Locale } from "./types.js";
import { TemplateError } from "./types.js";

export type ParamValue = string | number;

/**
 * Substitutes `{name}` and `{name, format}` placeholders.
 *
 * Formats: number, percent, currency, date. Anything else is refused at load.
 *
 * Substitution is single-pass over the template. A supplier can name a line
 * item `{vat_gap}` - party and item names are attacker-controlled text that
 * arrives by email from anyone who learns the inbox address - and a second pass
 * would happily expand it. One pass, and a substituted value is never rescanned.
 */
const PLACEHOLDER = /\{\s*([a-z_][a-z0-9_]*)\s*(?:,\s*([a-z]+)\s*)?\}/gi;

export const SUPPORTED_FORMATS = ["number", "percent", "currency", "date"] as const;
export type ParamFormat = (typeof SUPPORTED_FORMATS)[number];

function formatValue(
  value: ParamValue,
  format: ParamFormat | undefined,
  locale: Locale,
): string {
  const tag = locale === "tr" ? "tr-TR" : "de-DE";

  if (format === undefined) {
    // Control characters would let a crafted supplier name break the layout of
    // whatever renders this.
    return String(value).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  }

  const numeric = typeof value === "number" ? value : Number(String(value).replace(",", "."));

  switch (format) {
    case "number":
      if (!Number.isFinite(numeric)) return String(value);
      return new Intl.NumberFormat(tag, { maximumFractionDigits: 2 }).format(numeric);
    case "percent": {
      if (!Number.isFinite(numeric)) return String(value);
      const formatted = new Intl.NumberFormat(tag, { maximumFractionDigits: 2 }).format(numeric);
      // German writes "7 %", Turkish writes "%7". Intl's percent style would
      // also divide by 100, and these values arrive already as percentages.
      return locale === "tr" ? `%${formatted}` : `${formatted} %`;
    }
    case "currency":
      if (!Number.isFinite(numeric)) return String(value);
      return new Intl.NumberFormat(tag, {
        style: "currency",
        currency: "EUR",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(numeric);
    case "date": {
      const date = new Date(String(value));
      if (Number.isNaN(date.getTime())) return String(value);
      return new Intl.DateTimeFormat(tag, { dateStyle: "medium", timeZone: "UTC" }).format(date);
    }
  }
}

export interface FormatResult {
  text: string;
  /** Placeholders the template wanted and the caller did not supply. */
  missing: string[];
}

export function formatTemplate(
  template: string,
  params: Record<string, ParamValue>,
  locale: Locale,
): FormatResult {
  const missing: string[] = [];

  const text = template.replace(PLACEHOLDER, (whole, name: string, format?: string) => {
    if (!(name in params)) {
      missing.push(name);
      return whole;
    }
    if (format && !SUPPORTED_FORMATS.includes(format as ParamFormat)) {
      throw new TemplateError(`Unknown format "${format}" for {${name}}.`);
    }
    return formatValue(params[name] as ParamValue, format as ParamFormat | undefined, locale);
  });

  return { text, missing };
}

/** Placeholder names a template uses, for load-time validation. */
export function templatePlaceholders(template: string): string[] {
  const names = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1];
    const format = match[2];
    if (format && !SUPPORTED_FORMATS.includes(format as ParamFormat)) {
      throw new TemplateError(`Unknown format "${format}" for {${name ?? "?"}}.`);
    }
    if (name) names.add(name);
  }
  return [...names];
}
