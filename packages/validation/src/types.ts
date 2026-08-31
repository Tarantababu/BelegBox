import type { DetectionResult } from "@belegbox/core-invoice";

export type Layer = "l1_schema" | "l2_schematron" | "l3_domain" | "l4_tenant";

export type Severity = "form_error" | "content_error" | "warning" | "info";

/**
 * What a tenant-authored rule is allowed to emit.
 *
 * PRD § 6.4: user-defined rules may never produce a `form_error` - the L2
 * result is sacred. Encoding that as a type rather than a review comment means
 * an L4 rule that tries cannot compile.
 */
export type TenantSeverity = Exclude<Severity, "form_error">;

export type Verdict = "pass" | "fail" | "n_a" | "unknown";

/** Mirrors `documents.status`. */
export type DocumentStatus =
  | "clean"
  | "form_error"
  | "content_error"
  | "not_einvoice"
  | "pending";

/**
 * Requirement R-2. Every finding carries the versions that produced it so a
 * 2026 verdict can be re-derived in 2033. None of these is optional.
 */
export interface EngineVersions {
  /** Pinned KoSIT validator-configuration release, e.g. "2024-10-31". */
  validatorConfigVersion: string;
  /** Version of this pipeline package. */
  engineVersion: string;
  /** Set once an L4 tenant ruleset participates. */
  rulesetVersion?: number;
}

export interface Finding {
  layer: Layer;
  /** BR-CO-15, D-001, or a tenant rule id. */
  code: string;
  severity: Severity;
  /** The EN 16931 term this concerns, e.g. "BT-112". */
  btRef?: string;
  /** e.g. "§ 12 Abs. 2 Nr. 15 UStG". */
  legalBasis?: string;
  /** Validator output, stored verbatim. Shown next to the explanation. */
  messageRaw: string;
  /** Key into the explain template registry. Never a rendered string. */
  explainKey?: string;
  params?: Record<string, string | number>;
  versions: EngineVersions;
}

export interface LayerResult {
  ran: boolean;
  /** Why a layer did not run - unreachable validator, earlier failure, not built yet. */
  skippedReason?: string;
  findings: Finding[];
}

export interface ValidationResult {
  detection: DetectionResult;
  status: DocumentStatus;
  verdict: {
    /** Derived from L1 + L2 only. L3 and L4 cannot influence it. */
    form: Verdict;
    /** Derived from L3 + L4 only. */
    content: Verdict;
  };
  layers: {
    l1_schema: LayerResult;
    l2_schematron: LayerResult;
    l3_domain: LayerResult;
    l4_tenant: LayerResult;
  };
  findings: Finding[];
  versions: EngineVersions;
}
