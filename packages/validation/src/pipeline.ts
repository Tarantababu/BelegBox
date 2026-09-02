import {
  DetectionError,
  detect,
  parseInvoice,
  type DetectionResult,
  type Invoice,
} from "@belegbox/core-invoice";
import { evaluateRuleSet, type RuleFinding, type RuleSet } from "@belegbox/rules-engine";
import { runDomainRules, type SupplierHistory, type ViesLookup } from "./domain/rules.js";
import {
  MustangClient,
  MustangUnavailableError,
  toFindings,
} from "./mustang-client.js";
import type {
  DocumentStatus,
  EngineVersions,
  Finding,
  LayerResult,
  ValidationResult,
  Verdict,
} from "./types.js";

export const ENGINE_VERSION = "0.0.0-sprint0";

/** Placeholder until mustang-svc reports the pinned release (R-2). */
const CONFIG_UNKNOWN = "unavailable";

const NO_RULESET = "No ruleset loaded for this tenant.";
const NO_PARSED_CONTENT =
  "Document carries no structured content to evaluate.";

function empty(skippedReason: string): LayerResult {
  return { ran: false, skippedReason, findings: [] };
}

export interface ValidateOptions {
  client?: MustangClient;
  /** Skips the network call. Used by unit tests and by offline detection runs. */
  skipL1L2?: boolean;
  /** The tenant's L4 ruleset. Absent means only L3 runs. */
  ruleSet?: RuleSet;
  direction?: "incoming" | "outgoing";
  /** Ports for the domain rules that need lookups (D-004, D-007, D-009). */
  history?: SupplierHistory;
  vies?: ViesLookup;
  /** Pre-resolved VIES answers for L4 `vies_valid`, keyed by VAT id. */
  viesResults?: Record<string, boolean | undefined>;
}

export interface ValidateInput {
  filename: string;
  bytes: Buffer;
}

/**
 * Runs a document through the layered pipeline.
 *
 * The one invariant worth stating out loud: `verdict.form` is computed from L1
 * and L2 alone, and `verdict.content` from L3 and L4 alone. They never mix.
 * A syntactically perfect invoice can be materially wrong, and that pairing is
 * the whole product.
 */
/**
 * The ceiling on the deep parse, which is where the memory goes.
 *
 * Content rules need the whole invoice as an object tree - the totals in
 * BR-CO-15 are checked against every line - and that tree costs roughly fifteen
 * times the size of the file. A 25.7 MB Peppol invoice from the ZUGFeRD corpus
 * therefore wanted about 400 MB, on a machine that has 512 MB, and the process
 * was killed: the upload came back as a bare 502, and so did every other
 * request being served by that machine at the time.
 *
 * An OOM is not a failed upload, it is an outage for whoever else was there.
 * So the limit is stated rather than discovered, and the document above it is
 * still archived, still detected, and still gets its form verdict from KoSIT -
 * it is only the content layers that stand down, with the reason attached.
 *
 * 12 MB is far beyond any ordinary EN 16931 invoice; the only documents in the
 * corpus anywhere near it are the two deliberately-large stress fixtures.
 */
const MAX_DEEP_PARSE_BYTES = 12 * 1024 * 1024;

export async function validateDocument(
  input: ValidateInput,
  opts: ValidateOptions = {},
): Promise<ValidationResult> {
  let detection: DetectionResult;
  try {
    detection = detect(input.bytes);
  } catch (err) {
    if (err instanceof DetectionError) return notAnEInvoice(input.filename, err);
    throw err;
  }

  const versions: EngineVersions = {
    validatorConfigVersion: CONFIG_UNKNOWN,
    engineVersion: ENGINE_VERSION,
  };

  // --- L1 + L2 -------------------------------------------------------------
  let l1: LayerResult = empty("Not run.");
  let l2: LayerResult = empty("Not run.");
  let formVerdict: Verdict = "unknown";

  if (opts.skipL1L2) {
    const reason = "Skipped by caller.";
    l1 = empty(reason);
    l2 = empty(reason);
    formVerdict = "unknown";
  } else if (detection.profile.legalClass === "not_einvoice") {
    // Running the XRechnung schema over a ZUGFeRD MINIMUM document is a
    // category error: it is not an e-invoice, so "schema invalid" is neither
    // news nor useful. D-001 has already said the thing worth saying.
    const reason = `Profile ${detection.profile.name} is not an e-invoice; the form check does not apply.`;
    l1 = empty(reason);
    l2 = empty(reason);
    formVerdict = "n_a";
  } else {
    const client = opts.client ?? new MustangClient();
    try {
      const res = await client.validate({
        filename: input.filename,
        bytes: input.bytes,
      });
      versions.validatorConfigVersion = res.validatorConfigVersion;

      const all = toFindings(res, versions);
      l1 = { ran: res.l1.ran, findings: all.filter((f) => f.layer === "l1_schema") };
      l2 = {
        ran: res.l2.ran,
        ...(res.l2.skippedReason ? { skippedReason: res.l2.skippedReason } : {}),
        findings: all.filter((f) => f.layer === "l2_schematron"),
      };
      formVerdict = res.l1.valid && res.l2.valid ? "pass" : "fail";
    } catch (err) {
      if (!(err instanceof MustangUnavailableError)) throw err;
      // Honest degradation: no verdict is better than a guessed verdict.
      const reason = err.message;
      l1 = empty(reason);
      l2 = empty(reason);
      formVerdict = "unknown";
    }
  }

  // --- L3 + L4 -------------------------------------------------------------
  //
  // Both content layers evaluate against the parsed invoice, and both are
  // barred from touching the form verdict. L4 cannot even express a form_error:
  // the loader rejects that severity and the type excludes it.
  const direction = opts.direction ?? "incoming";
  let invoice: Invoice | undefined;
  let parseError: string | undefined;

  if (input.bytes.length > MAX_DEEP_PARSE_BYTES) {
    // Not a failure - a refusal, with the reasons stated. Everything cheap has
    // already happened: the bytes are archived, the profile is known, and the
    // KoSIT verdict stands. Only the content rules are skipped, and they say so
    // rather than reporting silence as a pass.
    parseError =
      `Document is ${(input.bytes.length / 1_000_000).toFixed(1)} MB. ` +
      `Content rules read the whole invoice into memory and are not run above ` +
      `${MAX_DEEP_PARSE_BYTES / 1_000_000} MB.`;
  } else {
    try {
      invoice = parseInvoice(input.bytes);
    } catch (err) {
      parseError = (err as Error).message;
    }
  }

  let l3: LayerResult;
  let l4: LayerResult;

  if (!invoice) {
    l3 = empty(parseError ?? NO_PARSED_CONTENT);
    l4 = empty(parseError ?? NO_PARSED_CONTENT);
  } else {
    const domainFindings = await runDomainRules({
      invoice,
      detection,
      versions,
      direction,
      ...(opts.history ? { history: opts.history } : {}),
      ...(opts.vies ? { vies: opts.vies } : {}),
    });
    l3 = { ran: true, findings: domainFindings };

    if (!opts.ruleSet) {
      l4 = empty(NO_RULESET);
    } else if (detection.profile.legalClass === "not_einvoice") {
      // A MINIMUM profile has no lines for a ruleset to read. Running it would
      // produce silence that looks like a pass.
      l4 = empty("Document is not an e-invoice; tenant rules were not applied.");
    } else {
      const evaluation = evaluateRuleSet(opts.ruleSet, {
        invoice,
        direction,
        ...(opts.viesResults ? { viesResults: opts.viesResults } : {}),
      });
      l4 = {
        ran: true,
        findings: evaluation.findings.map((f) =>
          tenantFinding(f, versions, opts.ruleSet?.version),
        ),
      };
    }
  }

  const contentFindings = [...l3.findings, ...l4.findings];
  const contentFailed = contentFindings.some((f) => f.severity === "content_error");
  const contentVerdict: Verdict =
    detection.profile.legalClass === "not_einvoice"
      ? "n_a"
      : !l3.ran
        ? "unknown"
        : contentFailed
          ? "fail"
          : "pass";

  const findings = [...l1.findings, ...l2.findings, ...contentFindings];

  return {
    detection,
    status: deriveStatus(detection, formVerdict, contentVerdict),
    verdict: { form: detection.profile.legalClass === "not_einvoice" ? "n_a" : formVerdict, content: contentVerdict },
    layers: { l1_schema: l1, l2_schematron: l2, l3_domain: l3, l4_tenant: l4 },
    findings,
    versions,
  };
}

function deriveStatus(
  detection: DetectionResult,
  form: Verdict,
  content: Verdict,
): DocumentStatus {
  if (detection.profile.legalClass === "not_einvoice") return "not_einvoice";
  if (form === "fail") return "form_error";

  // Content is judged before an unrun form check, so the status reports the
  // strongest thing actually known. The other order looks reasonable and is
  // wrong: a document with a confirmed content error and an unreachable
  // validator would report "pending", take a grey spine, and disappear into
  // the inbox - hiding the one finding the product exists to surface.
  if (content === "fail") return "content_error";
  if (form === "unknown") return "pending";
  return "clean";
}

/** A document with no structured data at all - PDF, scan, unparseable XML. */
function notAnEInvoice(filename: string, err: DetectionError): ValidationResult {
  const versions: EngineVersions = {
    validatorConfigVersion: CONFIG_UNKNOWN,
    engineVersion: ENGINE_VERSION,
  };
  const finding: Finding = {
    layer: "l3_domain",
    code: "D-000",
    severity: "warning",
    messageRaw: err.message,
    explainKey: `domain.d000.${err.code}`,
    params: { filename },
    versions,
  };
  const reason = "No structured e-invoice data.";
  return {
    detection: {
      syntax: "ubl",
      format: "other",
      rootElement: "",
      profile: { urn: "", name: "None", legalClass: "not_einvoice" },
    },
    status: "not_einvoice",
    verdict: { form: "n_a", content: "n_a" },
    layers: {
      l1_schema: empty(reason),
      l2_schematron: empty(reason),
      l3_domain: { ran: true, findings: [finding] },
      l4_tenant: empty(reason),
    },
    findings: [finding],
    versions,
  };
}

/**
 * Lifts an L4 rule finding into the pipeline's finding shape.
 *
 * The ruleset version travels with it (R-2): re-deriving a verdict in 2033
 * needs the rules that produced it, not just the validator that ran alongside.
 */
function tenantFinding(
  f: RuleFinding,
  versions: EngineVersions,
  rulesetVersion: number | undefined,
): Finding {
  const scope = f.scopeRef ? ` (${f.scopeRef.kind} ${f.scopeRef.id ?? f.scopeRef.index + 1})` : "";
  return {
    layer: "l4_tenant",
    code: f.ruleId,
    severity: f.severity,
    ...(f.legalBasis ? { legalBasis: f.legalBasis } : {}),
    messageRaw: f.message ?? `Rule ${f.ruleId} v${f.ruleVersion} matched${scope}.`,
    explainKey: f.explainKey,
    params: f.params,
    versions: {
      ...versions,
      ...(rulesetVersion !== undefined ? { rulesetVersion } : {}),
    },
  };
}
