export { loadRuleSet } from "./load.js";
export {
  conditionFields,
  evaluateRuleSet,
  iterationScope,
  ruleApplies,
  type EvaluationResult,
} from "./evaluate.js";
export { dryRun, type DryRunDocument, type DryRunHit, type DryRunReport } from "./dry-run.js";
export { evaluateExpression, expressionFields, ExpressionError } from "./expr.js";
export {
  countryOfIban,
  countryOfVatId,
  isKnownField,
  knownFields,
  resolveField,
  scopeOfField,
  LEITWEG_ID,
  type ResolutionScope,
} from "./fields.js";
export { BUILTIN_LEXICONS, fold, matchesLexicon, resolveLexicon } from "./lexicons.js";
export { applyOperator, OPERATORS } from "./operators.js";
export {
  RuleSetError,
  type Action,
  type Condition,
  type ConditionNode,
  type EvaluationContext,
  type Operator,
  type Rule,
  type RuleFinding,
  type RuleScope,
  type RuleSet,
  type RuleSeverity,
} from "./types.js";
