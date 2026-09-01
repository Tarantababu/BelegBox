import type { Finding, EngineVersions, Layer, Severity } from "./types.js";

/**
 * Wire contract with `services/mustang-svc`. The Java side owns both L1 (XSD)
 * and L2 (KoSIT Schematron) because both validators are JVM-native and the
 * KoSIT configuration must be pinned in exactly one place.
 */
export interface MustangValidateRequest {
  filename: string;
  /** The raw document bytes, passed through untouched. */
  bytes: Buffer;
}

export interface MustangFinding {
  layer: "l1_schema" | "l2_schematron";
  code: string;
  severity: "error" | "warning" | "info";
  btRef?: string;
  message: string;
}

export interface MustangValidateResponse {
  /** Echo of the pinned configuration, for R-2. */
  validatorConfigVersion: string;
  mustangVersion: string;
  l1: { ran: boolean; valid: boolean };
  l2: { ran: boolean; valid: boolean; skippedReason?: string };
  findings: MustangFinding[];
}

export class MustangUnavailableError extends Error {
  constructor(
    readonly url: string,
    override readonly cause: unknown,
  ) {
    super(
      `mustang-svc unreachable at ${url}. Start it with \`pnpm svc:up\` (needs Docker).`,
    );
    this.name = "MustangUnavailableError";
  }
}

export interface MustangClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * What the running sidecar says it is.
 *
 * Asked rather than assumed. A constant compiled into the Node process would
 * describe the sidecar we think is deployed; this describes the one that
 * actually judged the documents, which is the only version worth writing into
 * a Verfahrensdokumentation.
 */
export interface MustangHealth {
  status: string;
  validatorConfigVersion: string;
  validatorConfigSha256: string;
  kositVersion: string;
  mustangVersion: string;
}

export class MustangClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: MustangClientOptions = {}) {
    this.baseUrl = (
      opts.baseUrl ??
      process.env["MUSTANG_SVC_URL"] ??
      "http://localhost:8081"
    ).replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async health(): Promise<MustangHealth> {
    const url = `${this.baseUrl}/health`;
    try {
      const res = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        throw new Error(`mustang-svc responded ${res.status} ${res.statusText}`);
      }
      return (await res.json()) as MustangHealth;
    } catch (cause) {
      throw new MustangUnavailableError(url, cause);
    }
  }

  async validate(req: MustangValidateRequest): Promise<MustangValidateResponse> {
    const url = `${this.baseUrl}/validate`;
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/xml",
          // Filename travels in a header so the body stays byte-identical to
          // what was archived - never re-serialised on the way through.
          "x-belegbox-filename": encodeURIComponent(req.filename),
        },
        body: new Uint8Array(req.bytes),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        throw new Error(`mustang-svc responded ${res.status} ${res.statusText}`);
      }
      return (await res.json()) as MustangValidateResponse;
    } catch (cause) {
      throw new MustangUnavailableError(url, cause);
    }
  }
}

/**
 * Maps validator output onto the internal finding shape.
 *
 * L1 and L2 are the only layers permitted to raise `form_error`, so a validator
 * `error` maps straight to it. Warnings never touch the form verdict.
 */
export function toFindings(
  res: MustangValidateResponse,
  versions: EngineVersions,
): Finding[] {
  return res.findings.map((f) => {
    const severity: Severity =
      f.severity === "error" ? "form_error" : f.severity === "warning" ? "warning" : "info";
    const layer: Layer = f.layer;
    return {
      layer,
      code: f.code,
      severity,
      ...(f.btRef ? { btRef: f.btRef } : {}),
      messageRaw: f.message,
      explainKey: `l2.${f.code.toLowerCase()}`,
      versions,
    };
  });
}
