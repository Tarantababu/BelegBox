import { evaluateExpression } from "./expr.js";
import { resolveField, scopeOfField, type IterationScope, type ResolutionScope } from "./fields.js";
import { applyOperator } from "./operators.js";
import type {
  Action,
  Condition,
  ConditionNode,
  EvaluationContext,
  Rule,
  RuleFinding,
  RuleSet,
} from "./types.js";
import { RuleSetError } from "./types.js";

function isGroup(node: ConditionNode): node is Exclude<ConditionNode, Condition> {
  return "all" in node || "any" in node || "none" in node;
}

/** Every field path a condition tree touches. */
export function conditionFields(node: ConditionNode): string[] {
  if (!isGroup(node)) return [node.field];
  const children = "all" in node ? node.all : "any" in node ? node.any : node.none;
  return children.flatMap(conditionFields);
}

/**
 * Which collection the rule iterates over.
 *
 * A rule referencing `line.*` runs once per line and can flag one specific
 * line; a rule referencing `tax.*` runs once per VAT breakdown entry. Mixing
 * the two in one condition tree has no coherent meaning - which line pairs with
 * which subtotal? - so it is refused at load time rather than resolved by
 * guesswork.
 */
export function iterationScope(rule: Rule): IterationScope {
  const scopes = new Set(conditionFields(rule.when).map(scopeOfField));
  scopes.delete("document");

  if (scopes.size > 1) {
    throw new RuleSetError(
      "Conditions mix line.* and tax.* fields; a rule can iterate over one or the other.",
      rule.id,
    );
  }
  return (scopes.values().next().value as IterationScope) ?? "document";
}

interface ConditionOutcome {
  matched: boolean;
  detail: Record<string, string | number>;
}

function evaluateNode(
  node: ConditionNode,
  scope: ResolutionScope,
  context: EvaluationContext,
  rule: Rule,
): ConditionOutcome {
  if (isGroup(node)) {
    if ("all" in node) {
      const detail: Record<string, string | number> = {};
      for (const child of node.all) {
        const outcome = evaluateNode(child, scope, context, rule);
        Object.assign(detail, outcome.detail);
        if (!outcome.matched) return { matched: false, detail: {} };
      }
      return { matched: true, detail };
    }
    if ("any" in node) {
      for (const child of node.any) {
        const outcome = evaluateNode(child, scope, context, rule);
        if (outcome.matched) return outcome;
      }
      return { matched: false, detail: {} };
    }
    for (const child of node.none) {
      if (evaluateNode(child, scope, context, rule).matched) {
        return { matched: false, detail: {} };
      }
    }
    return { matched: true, detail: {} };
  }

  const actual = resolveField(node.field, scope);
  const result = applyOperator({
    actual,
    condition: node,
    ...(context.lexicons ? { lexicons: context.lexicons } : {}),
    ...(context.viesResults ? { viesResults: context.viesResults } : {}),
  });

  if (!result.matched) return { matched: false, detail: {} };

  const detail: Record<string, string | number> = { ...result.detail };
  if (typeof actual === "string" || typeof actual === "number") {
    detail[node.field.replace(/\./g, "_")] = actual;
  }
  return { matched: true, detail };
}

/** R-1: a rule applies by the document's issue date, never by now(). */
export function ruleApplies(rule: Rule, context: EvaluationContext): boolean {
  if (rule.scope !== "both" && rule.scope !== context.direction) return false;

  const on = context.evaluationDate ?? context.invoice.issueDate;
  if (!on) {
    // No issue date means the document is broken in a way L2 will already have
    // said something about. Applying date-bounded rules to it would be guessing.
    return !rule.effective_from && !rule.effective_to;
  }
  if (rule.effective_from && on < rule.effective_from) return false;
  if (rule.effective_to && on >= rule.effective_to) return false;
  return true;
}

function runActions(
  rule: Rule,
  scope: ResolutionScope,
  matchDetail: Record<string, string | number>,
): { findings: RuleFinding[]; tags: string[] } {
  const params: Record<string, string | number> = { ...matchDetail };
  const tags: string[] = [];
  const vars: Record<string, number> = {};
  const flags: Array<Extract<Action, { action: "flag" }>> = [];
  const requiredMissing: string[] = [];

  for (const action of rule.then) {
    switch (action.action) {
      case "compute": {
        // Computed before flags are emitted, so a flag can quote the number.
        const value = evaluateExpression(action.expr, (path) =>
          resolveField(path, { ...scope, vars }),
        );
        const rounded = Math.round(value * 100) / 100;
        vars[action.var] = rounded;
        params[action.var] = rounded;
        break;
      }
      case "tag":
        tags.push(action.tag);
        break;
      case "flag":
        flags.push(action);
        break;
      case "require_field": {
        const value = resolveField(action.field, { ...scope, vars });
        if (value === undefined || value === null || String(value).trim() === "") {
          requiredMissing.push(action.field);
          if (action.explain_key) {
            flags.push({ action: "flag", explain_key: action.explain_key });
          }
        }
        break;
      }
      case "notify":
        // Delivery is the notification service's job (F1 week 4-5). Recording
        // the intent here keeps the rule engine free of side effects, which is
        // what makes dry-run trustworthy.
        params["notify_channel"] = action.channel;
        break;
    }
  }

  if (requiredMissing.length > 0) params["missing_fields"] = requiredMissing.join(", ");

  const scopeRef =
    scope.line !== undefined && scope.lineIndex !== undefined
      ? ({ kind: "line", index: scope.lineIndex, ...(scope.line.id ? { id: scope.line.id } : {}) } as const)
      : scope.tax !== undefined && scope.taxIndex !== undefined
        ? ({ kind: "tax", index: scope.taxIndex } as const)
        : undefined;

  const findings = flags.map((flag) => ({
    ruleId: rule.id,
    ruleVersion: rule.version,
    severity: rule.severity,
    explainKey: flag.explain_key,
    ...(flag.message ? { message: flag.message } : {}),
    ...(rule.legal_basis ? { legalBasis: rule.legal_basis } : {}),
    ...(scopeRef ? { scopeRef } : {}),
    params,
    tags,
  }));

  return { findings, tags };
}

export interface EvaluationResult {
  findings: RuleFinding[];
  tags: string[];
  /** Rules that were skipped, and why. Dry-run reports read this. */
  skipped: Array<{ ruleId: string; reason: string }>;
}

export function evaluateRuleSet(
  ruleSet: RuleSet,
  context: EvaluationContext,
): EvaluationResult {
  const findings: RuleFinding[] = [];
  const tags = new Set<string>();
  const skipped: Array<{ ruleId: string; reason: string }> = [];

  const lexicons = { ...ruleSet.lexicons, ...context.lexicons };
  const scoped: EvaluationContext = { ...context, lexicons };

  for (const rule of ruleSet.rules) {
    if (!ruleApplies(rule, scoped)) {
      skipped.push({ ruleId: rule.id, reason: "outside scope or effective window" });
      continue;
    }

    const iteration = iterationScope(rule);
    const scopes: ResolutionScope[] =
      iteration === "line"
        ? context.invoice.lines.map((line, lineIndex) => ({
            invoice: context.invoice,
            direction: context.direction,
            line,
            lineIndex,
          }))
        : iteration === "tax"
          ? context.invoice.taxBreakdown.map((tax, taxIndex) => ({
              invoice: context.invoice,
              direction: context.direction,
              tax,
              taxIndex,
            }))
          : [{ invoice: context.invoice, direction: context.direction }];

    if (scopes.length === 0) {
      // A line rule against a document with no lines - a ZUGFeRD MINIMUM, say.
      // D-001 is what judges that, not a silently non-matching rule.
      skipped.push({ ruleId: rule.id, reason: `no ${iteration} entries to evaluate` });
      continue;
    }

    for (const scope of scopes) {
      const outcome = evaluateNode(rule.when, scope, scoped, rule);
      if (!outcome.matched) continue;

      const { findings: produced, tags: produtedTags } = runActions(rule, scope, outcome.detail);
      findings.push(...produced);
      for (const tag of produtedTags) tags.add(tag);
    }
  }

  return { findings, tags: [...tags], skipped };
}
