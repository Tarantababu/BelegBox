import { matchesLexicon, resolveLexicon } from "./lexicons.js";
import type { Condition, Operator } from "./types.js";
import { RuleSetError } from "./types.js";

/** Cent-level tolerance. Invoice arithmetic is decimal; comparison is binary. */
const EPSILON = 0.005;

const MAX_PATTERN_LENGTH = 200;
const MAX_SUBJECT_LENGTH = 4000;

export interface OperatorInput {
  actual: unknown;
  condition: Condition;
  lexicons?: Record<string, string[]>;
  viesResults?: Record<string, boolean | undefined>;
}

export interface OperatorOutput {
  matched: boolean;
  /** Extra detail worth carrying into the finding, e.g. which lexicon term hit. */
  detail?: Record<string, string | number>;
  /**
   * The operator could not reach an answer - a VIES lookup that never ran, for
   * instance. An abstaining condition never matches, and never claims the
   * negative either.
   */
  abstained?: boolean;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const n = Number(value.replace(",", "."));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function looseEquals(a: unknown, b: unknown): boolean {
  const na = toNumber(a);
  const nb = toNumber(b);
  if (na !== undefined && nb !== undefined) return Math.abs(na - nb) < EPSILON;
  if (a === undefined || a === null || b === undefined || b === null) return a === b;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Compiles a rule-supplied regular expression.
 *
 * Node has no regex timeout, so a catastrophically backtracking pattern would
 * hang the worker. Two bounds apply: the pattern and the subject are both
 * length-capped, and patterns with a quantifier applied to an already-quantified
 * group - the shape behind almost every real ReDoS - are refused outright.
 *
 * This is a mitigation, not a proof. Rule YAML is ours in F1; when the no-code
 * builder opens rule authoring to tenants in F3, this needs a non-backtracking
 * engine (RE2) rather than a heuristic.
 */
function compilePattern(pattern: string, ruleField: string): RegExp {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new RuleSetError(
      `Regular expression for ${ruleField} is longer than ${MAX_PATTERN_LENGTH} characters.`,
    );
  }
  if (/\([^)]*[+*][^)]*\)\s*[+*{]/.test(pattern)) {
    throw new RuleSetError(
      `Regular expression for ${ruleField} nests quantifiers, which risks catastrophic backtracking. Rewrite it without a quantified group inside a quantified group.`,
    );
  }
  try {
    return new RegExp(pattern, "iu");
  } catch (err) {
    throw new RuleSetError(`Invalid regular expression for ${ruleField}: ${(err as Error).message}`);
  }
}

export function applyOperator(input: OperatorInput): OperatorOutput {
  const { actual, condition } = input;
  const expected = condition.value;
  const op: Operator = condition.op;

  switch (op) {
    case "equals":
      return { matched: looseEquals(actual, expected) };

    case "not_equals":
      return { matched: !looseEquals(actual, expected) };

    case "gt":
    case "lt":
    case "gte":
    case "lte": {
      const a = toNumber(actual);
      const b = toNumber(expected);
      // A comparison against a missing value is not false, it is unanswerable.
      // Reporting false would let "amount lt 100" quietly match nothing.
      if (a === undefined || b === undefined) return { matched: false, abstained: true };
      if (op === "gt") return { matched: a > b };
      if (op === "lt") return { matched: a < b };
      if (op === "gte") return { matched: a >= b - EPSILON };
      return { matched: a <= b + EPSILON };
    }

    case "between": {
      const a = toNumber(actual);
      if (a === undefined || !Array.isArray(expected) || expected.length !== 2) {
        return { matched: false, abstained: true };
      }
      const lo = toNumber(expected[0]);
      const hi = toNumber(expected[1]);
      if (lo === undefined || hi === undefined) return { matched: false, abstained: true };
      return { matched: a >= lo - EPSILON && a <= hi + EPSILON };
    }

    case "in": {
      if (!Array.isArray(expected)) {
        throw new RuleSetError(`Operator "in" needs a list value for ${condition.field}.`);
      }
      return { matched: expected.some((candidate) => looseEquals(actual, candidate)) };
    }

    case "matches_regex": {
      if (typeof expected !== "string") {
        throw new RuleSetError(`Operator "matches_regex" needs a string for ${condition.field}.`);
      }
      if (typeof actual !== "string") return { matched: false };
      const subject = actual.slice(0, MAX_SUBJECT_LENGTH);
      return { matched: compilePattern(expected, condition.field).test(subject) };
    }

    case "matches_lexicon": {
      if (typeof expected !== "string") {
        throw new RuleSetError(`Operator "matches_lexicon" needs a lexicon name for ${condition.field}.`);
      }
      const terms = resolveLexicon(expected, input.lexicons);
      if (!terms) {
        throw new RuleSetError(`Unknown lexicon "${expected}" for ${condition.field}.`);
      }
      if (typeof actual !== "string") return { matched: false };
      const hit = matchesLexicon(actual.slice(0, MAX_SUBJECT_LENGTH), terms);
      return hit.matched
        ? { matched: true, detail: { lexicon: expected, matched_term: hit.term as string } }
        : { matched: false };
    }

    case "is_empty":
      return { matched: isEmpty(actual) };

    case "is_present":
      return { matched: !isEmpty(actual) };

    case "vies_valid": {
      const vatId = typeof actual === "string" ? actual.replace(/\s+/g, "").toUpperCase() : "";
      const result = input.viesResults?.[vatId];
      // VIES is frequently down. An unavailable lookup abstains rather than
      // asserting a VAT id is invalid - a tax authority outage must never tell
      // a customer their supplier's invoice is wrong.
      if (result === undefined) return { matched: false, abstained: true };
      const wanted = expected === undefined ? true : Boolean(expected);
      return { matched: result === wanted, detail: { vat_id: vatId } };
    }

    default: {
      const exhaustive: never = op;
      throw new RuleSetError(`Unsupported operator "${String(exhaustive)}".`);
    }
  }
}

export const OPERATORS: readonly Operator[] = [
  "equals",
  "not_equals",
  "gt",
  "lt",
  "gte",
  "lte",
  "between",
  "in",
  "matches_regex",
  "matches_lexicon",
  "is_empty",
  "is_present",
  "vies_valid",
];
