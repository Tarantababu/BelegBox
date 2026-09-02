import { FORMAT_LOCALE, type Key } from "./i18n";
import type { DocumentStatus, Verdict } from "./api";

/**
 * The status model from PRD § 5.3. Every document is in exactly one state, and
 * the spine colour is how it reads at a glance.
 *
 * The labels used to sit here as a `{ de, tr }` pair on each entry, which meant
 * adding a language meant editing this file, the verdict map below, and every
 * `locale === "tr" ? meta.tr : meta.de` at each call site. They are dictionary
 * keys now; the colour stays, because it is not language.
 */
export const STATUS_META: Record<DocumentStatus, { spine: "ok" | "warn" | "bad" | ""; key: Key }> = {
  clean: { spine: "ok", key: "status.clean" },
  form_error: { spine: "warn", key: "status.form_error" },
  content_error: { spine: "bad", key: "status.content_error" },
  not_einvoice: { spine: "", key: "status.not_einvoice" },
  pending: { spine: "", key: "status.pending" },
};

export const VERDICT_META: Record<Verdict, { cls: string; key: Key }> = {
  pass: { cls: "ok", key: "verdict.pass" },
  fail: { cls: "bad", key: "verdict.fail" },
  n_a: { cls: "none", key: "verdict.n_a" },
  // Shown when mustang-svc is unreachable. A verdict is never guessed, so the
  // screen has to be able to say it does not know.
  unknown: { cls: "warn", key: "verdict.unknown" },
};

/**
 * Money and dates stay German whatever the interface language is - see the note
 * on FORMAT_LOCALE. The number on the screen has to be the number on the
 * invoice.
 */
export function money(value: number | null): string {
  if (value === null) return "—";
  return `${value.toLocaleString(FORMAT_LOCALE, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} €`;
}

export function day(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(FORMAT_LOCALE);
}
