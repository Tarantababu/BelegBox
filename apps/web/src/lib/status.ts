import type { DocumentStatus, Verdict } from "./api";

/**
 * The status model from PRD § 5.3. Every document is in exactly one state, and
 * the spine colour is how it reads at a glance.
 */
export const STATUS_META: Record<
  DocumentStatus,
  { spine: "ok" | "warn" | "bad" | ""; de: string; tr: string }
> = {
  clean: { spine: "ok", de: "Sauber", tr: "Temiz" },
  form_error: { spine: "warn", de: "Formfehler", tr: "Form hatası" },
  content_error: { spine: "bad", de: "Sachfehler", tr: "İçerik hatası" },
  not_einvoice: { spine: "", de: "Keine E-Rechnung", tr: "E-fatura değil" },
  pending: { spine: "", de: "In Prüfung", tr: "İnceleniyor" },
};

export const VERDICT_META: Record<Verdict, { cls: string; de: string; tr: string }> = {
  pass: { cls: "ok", de: "Bestanden", tr: "Geçerli" },
  fail: { cls: "bad", de: "Fehlerhaft", tr: "Hatalı" },
  n_a: { cls: "none", de: "Nicht anwendbar", tr: "Uygulanmaz" },
  // Shown when mustang-svc is unreachable. A verdict is never guessed, so the
  // screen has to be able to say it does not know.
  unknown: { cls: "warn", de: "Noch offen", tr: "Henüz belli değil" },
};

export function money(value: number | null): string {
  if (value === null) return "—";
  return `${value.toLocaleString("de-DE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} €`;
}

export function day(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString("de-DE");
}
