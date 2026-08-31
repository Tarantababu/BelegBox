export { DISCLAIMERS, disclaimerFor } from "./disclaimer.js";
export {
  formatTemplate,
  templatePlaceholders,
  SUPPORTED_FORMATS,
  type FormatResult,
  type ParamFormat,
  type ParamValue,
} from "./format.js";
export { describeProblems, lintText, type LintProblem, type LintRule } from "./lint.js";
export { loadTemplate } from "./load.js";
export { loadTemplateDir, TEMPLATES_DIR } from "./registry-fs.js";
export {
  MissingTemplateError,
  TemplateRegistry,
  renderBoth,
  renderExplanation,
  type Registry,
  type RenderOptions,
} from "./render.js";
export {
  LOCALES,
  TemplateError,
  type BasisKind,
  type ExplainTemplate,
  type Locale,
  type LocaleText,
  type RenderedExplanation,
} from "./types.js";
