import type { Invoice } from "@belegbox/core-invoice";

/**
 * L4 severities.
 *
 * PRD § 6.4: a tenant-authored rule may never produce a `form_error`. The L2
 * result is sacred - it is what the official validator said, and nothing above
 * it gets to overrule it. The type says so, the loader rejects it, and the
 * database has a CHECK constraint saying the same thing.
 */
export type RuleSeverity = "content_error" | "warning" | "info";

export type RuleScope = "incoming" | "outgoing" | "both";

export type Operator =
  | "equals"
  | "not_equals"
  | "gt"
  | "lt"
  | "gte"
  | "lte"
  | "between"
  | "in"
  | "matches_regex"
  | "matches_lexicon"
  | "is_empty"
  | "is_present"
  | "vies_valid";

export interface Condition {
  field: string;
  op: Operator;
  value?: unknown;
}

export type ConditionGroup =
  | { all: ConditionNode[] }
  | { any: ConditionNode[] }
  | { none: ConditionNode[] };

export type ConditionNode = Condition | ConditionGroup;

export type Action =
  | { action: "flag"; explain_key: string; message?: string }
  | { action: "tag"; tag: string }
  | { action: "compute"; var: string; expr: string }
  | { action: "require_field"; field: string; explain_key?: string }
  | { action: "notify"; channel: string; explain_key?: string };

export interface Rule {
  id: string;
  version: number;
  severity: RuleSeverity;
  scope: RuleScope;
  when: ConditionNode;
  then: Action[];
  legal_basis?: string;
  /**
   * R-1. A rule applies to documents issued in this window, judged by BT-2 and
   * never by now(). Without it the 2026 beverage rule re-judges every invoice
   * already in the archive.
   */
  effective_from?: string;
  effective_to?: string;
  description?: string;
}

export interface RuleSet {
  id: string;
  version: number;
  /** Sector template name, e.g. gastro-de. */
  template: string;
  description?: string;
  lexicons?: Record<string, string[]>;
  rules: Rule[];
}

/**
 * Everything evaluation needs beyond the invoice itself.
 *
 * VIES results are resolved *before* evaluation and passed in, so the evaluator
 * stays synchronous and pure. A rule engine that reaches the network mid-rule is
 * one that cannot be dry-run, cannot be replayed, and gives a different verdict
 * depending on whether a foreign tax authority is having a good day.
 */
export interface EvaluationContext {
  invoice: Invoice;
  direction: "incoming" | "outgoing";
  /** Keyed by VAT id. Absent means "not looked up"; the operator then abstains. */
  viesResults?: Record<string, boolean | undefined>;
  /** Extra lexicons layered over the ruleset's own. */
  lexicons?: Record<string, string[]>;
  /** Overrides the issue date used for rule selection. Testing only. */
  evaluationDate?: string;
}

export interface RuleFinding {
  ruleId: string;
  ruleVersion: number;
  severity: RuleSeverity;
  explainKey: string;
  message?: string;
  legalBasis?: string;
  /** Set when the rule matched a specific line or tax subtotal. */
  scopeRef?: { kind: "line" | "tax"; index: number; id?: string };
  /** Values produced by `compute`, plus the fields the conditions matched on. */
  params: Record<string, string | number>;
  tags: string[];
}

export class RuleSetError extends Error {
  constructor(
    message: string,
    readonly ruleId?: string,
  ) {
    super(ruleId ? `${ruleId}: ${message}` : message);
    this.name = "RuleSetError";
  }
}
