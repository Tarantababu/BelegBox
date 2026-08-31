import {
  renderExplanation,
  type Locale,
  type Registry,
} from "@belegbox/explain";
import type { ValidationResult, Verdict } from "@belegbox/validation";

const ESC = "\u001b";
const useColor = process.stdout.isTTY && !process.env["NO_COLOR"];
const paint = (code: string, s: string) =>
  useColor ? `${ESC}[${code}m${s}${ESC}[0m` : s;

const dim = (s: string) => paint("2", s);
const bold = (s: string) => paint("1", s);
const green = (s: string) => paint("32", s);
const red = (s: string) => paint("31", s);
const yellow = (s: string) => paint("33", s);

function verdictLabel(v: Verdict): string {
  switch (v) {
    case "pass":
      return green("pass");
    case "fail":
      return red("FAIL");
    case "n_a":
      return dim("n/a");
    case "unknown":
      return yellow("unknown");
  }
}

const SEVERITY_COLOR = {
  form_error: red,
  content_error: red,
  warning: yellow,
  info: dim,
} as const;

/**
 * Prints the dual verdict the way the product shows it - form and content side
 * by side, never merged into a single score.
 */
export interface ExplainOptions {
  registry: Registry;
  locale: Locale;
}

export function formatResult(
  filename: string,
  r: ValidationResult,
  explain?: ExplainOptions,
): string {
  const out: string[] = [];

  out.push(bold(filename));
  out.push(
    `  ${dim("format")}    ${r.detection.format}  ${dim("·")}  ${r.detection.syntax.toUpperCase()}  ${dim("·")}  ${r.detection.profile.name}`,
  );

  const idBits = [
    r.detection.invoiceNumber ? `BT-1 ${r.detection.invoiceNumber}` : null,
    r.detection.issueDate ? `BT-2 ${r.detection.issueDate}` : null,
    r.detection.documentTypeCode ? `BT-3 ${r.detection.documentTypeCode}` : null,
  ].filter((b): b is string => b !== null);
  if (idBits.length > 0) {
    out.push(`  ${dim("document")}  ${idBits.join(dim("  ·  "))}`);
  }

  out.push("");
  out.push(
    `  ${dim("Form (KoSIT)")}  ${verdictLabel(r.verdict.form)}` +
      `      ${dim("Content (Belegbox)")}  ${verdictLabel(r.verdict.content)}` +
      `      ${dim("status")}  ${r.status}`,
  );

  if (r.findings.length > 0) {
    out.push("");
    for (const f of r.findings) {
      const color = SEVERITY_COLOR[f.severity];
      const ref = f.btRef ? dim(`${f.btRef}  `) : "";
      out.push(
        `  ${color(f.code.padEnd(9))} ${dim(f.layer.padEnd(14))} ${ref}${f.messageRaw}`,
      );
      if (f.legalBasis) {
        out.push(`  ${" ".repeat(9)} ${dim(f.legalBasis)}`);
      }
      // Computed values are the point of the finding - a VAT gap the user can
      // check against their own arithmetic is what makes it actionable.
      const params = Object.entries(f.params ?? {});
      if (params.length > 0) {
        const rendered = params
          .map(([key, value]) => `${dim(key)} ${String(value)}`)
          .join(dim("  ·  "));
        out.push(`  ${" ".repeat(9)} ${rendered}`);
      }

      if (explain && f.explainKey) {
        // Templates are unapproved until the lawyer signs off. The CLI is a
        // development tool, so it renders them and says so.
        const text = renderExplanation(
          explain.registry,
          f.explainKey,
          explain.locale,
          f.params ?? {},
          { allowUnapproved: true, rawMessage: f.messageRaw },
        );
        const pad = " ".repeat(11);
        out.push("");
        out.push(`${pad}${text.observation}`);
        if (text.legalBasis) out.push(`${pad}${dim(text.legalBasis)}`);
        if (text.nextStep) out.push(`${pad}${dim(text.nextStep)}`);
        out.push(`${pad}${yellow(text.disclaimer)}`);
        if (text.fallback) {
          out.push(`${pad}${dim("(no template yet - raw validator output shown)")}`);
        }
        out.push("");
      }
    }
  }

  const skipped = Object.entries(r.layers).filter(([, l]) => l.skippedReason);
  if (skipped.length > 0) {
    out.push("");
    for (const [name, layer] of skipped) {
      out.push(
        `  ${yellow("skipped")}   ${dim(name.padEnd(14))} ${layer.skippedReason}`,
      );
    }
  }

  out.push("");
  out.push(
    dim(
      `  engine ${r.versions.engineVersion}   validator-config ${r.versions.validatorConfigVersion}`,
    ),
  );
  return out.join("\n");
}
