import { parse as parseYaml } from "yaml";
import { conditionFields, iterationScope } from "./evaluate.js";
import { expressionFields } from "./expr.js";
import { isKnownField, knownFields } from "./fields.js";
import { resolveLexicon } from "./lexicons.js";
import { applyOperator, OPERATORS } from "./operators.js";
import type {
  Action,
  Condition,
  ConditionNode,
  Rule,
  RuleSet,
  RuleSeverity,
  RuleScope,
} from "./types.js";
import { RuleSetError } from "./types.js";

const SEVERITIES: RuleSeverity[] = ["content_error", "warning", "info"];
const SCOPES: RuleScope[] = ["incoming", "outgoing", "both"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadCondition(raw: unknown, ruleId: string): ConditionNode {
  if (!isRecord(raw)) {
    throw new RuleSetError("A condition must be a mapping.", ruleId);
  }

  for (const key of ["all", "any", "none"] as const) {
    if (key in raw) {
      const children = raw[key];
      if (!Array.isArray(children) || children.length === 0) {
        throw new RuleSetError(`"${key}" must be a non-empty list.`, ruleId);
      }
      const parsed = children.map((child) => loadCondition(child, ruleId));
      if (key === "all") return { all: parsed };
      if (key === "any") return { any: parsed };
      return { none: parsed };
    }
  }

  const field = raw["field"];
  const op = raw["op"];
  if (typeof field !== "string") {
    throw new RuleSetError("A condition needs a string \"field\".", ruleId);
  }
  if (typeof op !== "string" || !OPERATORS.includes(op as never)) {
    throw new RuleSetError(
      `Unknown operator "${String(op)}" on ${field}. Supported: ${OPERATORS.join(", ")}.`,
      ruleId,
    );
  }
  if (!isKnownField(field)) {
    throw new RuleSetError(
      `Unknown field "${field}". Available fields: ${knownFields().join(", ")}.`,
      ruleId,
    );
  }

  const condition: Condition = { field, op: op as Condition["op"] };
  if ("value" in raw) condition.value = raw["value"];
  validateConditionValue(condition, ruleId);
  return condition;
}

/**
 * Checks that an operator's value has the shape that operator needs.
 *
 * Without this, `matches_lexicon` with a number loads cleanly and only fails
 * when a real document reaches it - which is the worst possible moment, because
 * the dry-run preview has already told the author the rule is fine. Everything
 * checkable without an invoice is checked here.
 */
function validateConditionValue(condition: Condition, ruleId: string): void {
  const { op, value, field } = condition;

  const needsString = op === "matches_lexicon" || op === "matches_regex";
  if (needsString && typeof value !== "string") {
    throw new RuleSetError(
      `Operator "${op}" on ${field} needs a string value, got ${describe(value)}.`,
      ruleId,
    );
  }

  if (op === "in" && !Array.isArray(value)) {
    throw new RuleSetError(`Operator "in" on ${field} needs a list value.`, ruleId);
  }

  if (op === "between" && (!Array.isArray(value) || value.length !== 2)) {
    throw new RuleSetError(
      `Operator "between" on ${field} needs a list of exactly two values.`,
      ruleId,
    );
  }

  if (
    (op === "gt" || op === "lt" || op === "gte" || op === "lte") &&
    typeof value !== "number"
  ) {
    throw new RuleSetError(`Operator "${op}" on ${field} needs a number.`, ruleId);
  }

  if (op === "matches_regex" && typeof value === "string") {
    // Compiling now surfaces an invalid or backtracking-prone pattern in the
    // rule builder rather than on an invoice at three in the morning.
    applyOperator({ actual: "", condition });
  }
}

function describe(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  return Array.isArray(value) ? "a list" : `a ${typeof value}`;
}

function loadAction(raw: unknown, ruleId: string): Action {
  if (!isRecord(raw) || typeof raw["action"] !== "string") {
    throw new RuleSetError("An action needs a string \"action\".", ruleId);
  }

  switch (raw["action"]) {
    case "flag": {
      const key = raw["explain_key"];
      if (typeof key !== "string" || key.trim() === "") {
        // Explanations are versioned templates, never free text assembled here.
        // A flag without a key has nothing to render and cannot be reviewed by
        // the lawyer, which is the whole point of the template registry.
        throw new RuleSetError('Action "flag" needs an explain_key.', ruleId);
      }
      return {
        action: "flag",
        explain_key: key,
        ...(typeof raw["message"] === "string" ? { message: raw["message"] } : {}),
      };
    }
    case "tag": {
      if (typeof raw["tag"] !== "string") {
        throw new RuleSetError('Action "tag" needs a tag.', ruleId);
      }
      return { action: "tag", tag: raw["tag"] };
    }
    case "compute": {
      const name = raw["var"];
      const expr = raw["expr"];
      if (typeof name !== "string" || typeof expr !== "string") {
        throw new RuleSetError('Action "compute" needs "var" and "expr".', ruleId);
      }
      for (const path of expressionFields(expr)) {
        if (!isKnownField(path)) {
          throw new RuleSetError(`Expression references unknown field "${path}".`, ruleId);
        }
      }
      return { action: "compute", var: name, expr };
    }
    case "require_field": {
      const field = raw["field"];
      if (typeof field !== "string" || !isKnownField(field)) {
        throw new RuleSetError(
          `Action "require_field" needs a known field, got "${String(field)}".`,
          ruleId,
        );
      }
      return {
        action: "require_field",
        field,
        ...(typeof raw["explain_key"] === "string" ? { explain_key: raw["explain_key"] } : {}),
      };
    }
    case "notify": {
      if (typeof raw["channel"] !== "string") {
        throw new RuleSetError('Action "notify" needs a channel.', ruleId);
      }
      return {
        action: "notify",
        channel: raw["channel"],
        ...(typeof raw["explain_key"] === "string" ? { explain_key: raw["explain_key"] } : {}),
      };
    }
    default:
      throw new RuleSetError(`Unsupported action "${String(raw["action"])}".`, ruleId);
  }
}

function loadRule(raw: unknown, lexicons: Record<string, string[]>): Rule {
  if (!isRecord(raw)) throw new RuleSetError("A rule must be a mapping.");

  const id = raw["id"];
  if (typeof id !== "string" || id.trim() === "") {
    throw new RuleSetError("A rule needs an id.");
  }

  const severity = raw["severity"];
  if (typeof severity !== "string" || !SEVERITIES.includes(severity as RuleSeverity)) {
    // The interesting rejection: severity: form_error. Only L1 and L2 decide
    // the form verdict, and a ruleset does not get to overrule the official
    // validator. Refused here, in the type system, and by a database CHECK.
    throw new RuleSetError(
      `Severity must be one of ${SEVERITIES.join(", ")}. A ruleset may never produce a form_error - that verdict belongs to L1 and L2 alone.`,
      id,
    );
  }

  const scope = raw["scope"] ?? "both";
  if (typeof scope !== "string" || !SCOPES.includes(scope as RuleScope)) {
    throw new RuleSetError(`Scope must be one of ${SCOPES.join(", ")}.`, id);
  }

  const version = raw["version"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new RuleSetError("A rule needs an integer version of 1 or more.", id);
  }

  for (const key of ["effective_from", "effective_to"] as const) {
    const value = raw[key];
    if (value !== undefined && (typeof value !== "string" || !ISO_DATE.test(value))) {
      throw new RuleSetError(`${key} must be a YYYY-MM-DD date.`, id);
    }
  }
  const from = raw["effective_from"] as string | undefined;
  const to = raw["effective_to"] as string | undefined;
  if (from && to && to <= from) {
    throw new RuleSetError("effective_to must be after effective_from.", id);
  }

  const then = raw["then"];
  if (!Array.isArray(then) || then.length === 0) {
    throw new RuleSetError("A rule needs at least one action.", id);
  }

  const rule: Rule = {
    id,
    version,
    severity: severity as RuleSeverity,
    scope: scope as RuleScope,
    when: loadCondition(raw["when"], id),
    then: then.map((action) => loadAction(action, id)),
    ...(typeof raw["legal_basis"] === "string" ? { legal_basis: raw["legal_basis"] } : {}),
    ...(typeof raw["description"] === "string" ? { description: raw["description"] } : {}),
    ...(from ? { effective_from: from } : {}),
    ...(to ? { effective_to: to } : {}),
  };

  // Fails now, at load, rather than on the one invoice a year that has lines
  // and a tax breakdown arranged to expose the ambiguity.
  iterationScope(rule);

  for (const field of conditionFields(rule.when)) {
    if (!isKnownField(field)) throw new RuleSetError(`Unknown field "${field}".`, id);
  }

  for (const node of flattenConditions(rule.when)) {
    if (node.op === "matches_lexicon" && typeof node.value === "string") {
      if (!resolveLexicon(node.value, lexicons)) {
        throw new RuleSetError(`Unknown lexicon "${node.value}".`, id);
      }
    }
  }

  return rule;
}

function flattenConditions(node: ConditionNode): Condition[] {
  if ("all" in node) return node.all.flatMap(flattenConditions);
  if ("any" in node) return node.any.flatMap(flattenConditions);
  if ("none" in node) return node.none.flatMap(flattenConditions);
  return [node];
}

/**
 * Parses and validates a ruleset.
 *
 * Everything that can be caught without an invoice is caught here: unknown
 * fields, unknown operators, unknown lexicons, malformed expressions,
 * ambiguous iteration, and any attempt to claim a form error. A ruleset that
 * loads is one that cannot fail for structural reasons at evaluation time.
 */
export function loadRuleSet(yaml: string): RuleSet {
  let doc: unknown;
  try {
    doc = parseYaml(yaml);
  } catch (err) {
    throw new RuleSetError(`Invalid YAML: ${(err as Error).message}`);
  }

  if (!isRecord(doc)) throw new RuleSetError("A ruleset must be a mapping.");

  const id = doc["id"];
  const template = doc["template"] ?? id;
  const version = doc["version"];
  if (typeof id !== "string") throw new RuleSetError("A ruleset needs an id.");
  if (typeof version !== "number") throw new RuleSetError("A ruleset needs a version.");

  const lexicons: Record<string, string[]> = {};
  if (doc["lexicons"] !== undefined) {
    if (!isRecord(doc["lexicons"])) throw new RuleSetError("lexicons must be a mapping.");
    for (const [name, terms] of Object.entries(doc["lexicons"])) {
      if (!Array.isArray(terms) || terms.some((t) => typeof t !== "string")) {
        throw new RuleSetError(`Lexicon "${name}" must be a list of strings.`);
      }
      lexicons[name] = terms as string[];
    }
  }

  const rules = doc["rules"];
  if (!Array.isArray(rules)) throw new RuleSetError("A ruleset needs a rules list.");

  const loaded = rules.map((rule) => loadRule(rule, lexicons));
  const ids = new Set<string>();
  for (const rule of loaded) {
    if (ids.has(rule.id)) throw new RuleSetError(`Duplicate rule id "${rule.id}".`);
    ids.add(rule.id);
  }

  return {
    id,
    version,
    template: String(template),
    ...(typeof doc["description"] === "string" ? { description: doc["description"] } : {}),
    ...(Object.keys(lexicons).length > 0 ? { lexicons } : {}),
    rules: loaded,
  };
}
