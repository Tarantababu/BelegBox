import { DetectionError, detect, type DetectionResult } from "@belegbox/core-invoice";
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

const NOT_BUILT_L3 =
  "L3 domain rules land in F1 week 3-4. Only D-001 (profile legality) is active.";
const NOT_BUILT_L4 = "L4 tenant rules land in F1 week 3-4.";

function empty(skippedReason: string): LayerResult {
  return { ran: false, skippedReason, findings: [] };
}

export interface ValidateOptions {
  client?: MustangClient;
  /** Skips the network call. Used by unit tests and by offline detection runs. */
  skipL1L2?: boolean;
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

  // --- L3 ------------------------------------------------------------------
  const l3Findings: Finding[] = [];
  if (detection.profile.legalClass === "not_einvoice") {
    l3Findings.push({
      layer: "l3_domain",
      code: "D-001",
      severity: "warning",
      btRef: "BT-24",
      legalBasis: "§ 14 Abs. 1 UStG",
      messageRaw: `Profile "${detection.profile.urn}" (${detection.profile.name}) carries no line-level data and is not an e-invoice.`,
      explainKey: "domain.d001.not_an_einvoice",
      params: { profile_urn: detection.profile.urn, profile_name: detection.profile.name },
      versions,
    });
  }
  const l3: LayerResult = { ran: true, skippedReason: NOT_BUILT_L3, findings: l3Findings };

  // --- L4 ------------------------------------------------------------------
  const l4: LayerResult = empty(NOT_BUILT_L4);

  const contentFindings = [...l3.findings, ...l4.findings];
  const contentFailed = contentFindings.some((f) => f.severity === "content_error");
  const contentVerdict: Verdict =
    detection.profile.legalClass === "not_einvoice"
      ? "n_a"
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
  if (form === "unknown") return "pending";
  if (content === "fail") return "content_error";
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
      l4_tenant: empty(NOT_BUILT_L4),
    },
    findings: [finding],
    versions,
  };
}
