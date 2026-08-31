import type { Invoice } from "@belegbox/core-invoice";
import { evaluateRuleSet } from "./evaluate.js";
import type { EvaluationContext, RuleFinding, RuleSet } from "./types.js";

export interface DryRunDocument {
  id: string;
  invoice: Invoice;
  direction?: "incoming" | "outgoing";
}

export interface DryRunHit {
  documentId: string;
  ruleId: string;
  severity: string;
  explainKey: string;
  params: Record<string, string | number>;
  scopeRef?: RuleFinding["scopeRef"];
}

export interface DryRunReport {
  ruleSetId: string;
  ruleSetVersion: number;
  documentsEvaluated: number;
  hits: DryRunHit[];
  /** Per rule, how many documents it would flag. */
  countsByRule: Record<string, number>;
  /** Rules that matched nothing at all. */
  silentRules: string[];
  errors: Array<{ documentId: string; message: string }>;
}

/**
 * Runs a ruleset over historical documents without touching them.
 *
 * PRD § 6.4 requires this before any rule can be saved: the author sees "this
 * rule would have flagged these 7 documents" against the last 90 days. It is
 * the single most important safety mechanism in the rule feature, because the
 * failure mode of a bad rule is not a crash - it is a stream of confident,
 * wrong findings that trains the user to ignore all of them.
 *
 * Nothing here writes. `notify` records its intent as a parameter rather than
 * sending anything, which is what makes a dry run safe to point at production
 * history.
 */
export function dryRun(
  ruleSet: RuleSet,
  documents: DryRunDocument[],
  context: Omit<EvaluationContext, "invoice" | "direction"> = {},
): DryRunReport {
  const hits: DryRunHit[] = [];
  const countsByRule: Record<string, number> = {};
  const errors: Array<{ documentId: string; message: string }> = [];

  for (const rule of ruleSet.rules) countsByRule[rule.id] = 0;

  for (const document of documents) {
    try {
      const result = evaluateRuleSet(ruleSet, {
        ...context,
        invoice: document.invoice,
        direction: document.direction ?? "incoming",
      });

      const seen = new Set<string>();
      for (const finding of result.findings) {
        hits.push({
          documentId: document.id,
          ruleId: finding.ruleId,
          severity: finding.severity,
          explainKey: finding.explainKey,
          params: finding.params,
          ...(finding.scopeRef ? { scopeRef: finding.scopeRef } : {}),
        });
        // Counted per document, not per line: "would flag 7 documents" is the
        // number the author is deciding on, and one invoice with nine bad lines
        // is still one invoice.
        if (!seen.has(finding.ruleId)) {
          seen.add(finding.ruleId);
          countsByRule[finding.ruleId] = (countsByRule[finding.ruleId] ?? 0) + 1;
        }
      }
    } catch (err) {
      // One malformed document must not hide what the rule does to the other
      // eighty-nine days.
      errors.push({ documentId: document.id, message: (err as Error).message });
    }
  }

  return {
    ruleSetId: ruleSet.id,
    ruleSetVersion: ruleSet.version,
    documentsEvaluated: documents.length,
    hits,
    countsByRule,
    silentRules: Object.entries(countsByRule)
      .filter(([, count]) => count === 0)
      .map(([id]) => id),
    errors,
  };
}
