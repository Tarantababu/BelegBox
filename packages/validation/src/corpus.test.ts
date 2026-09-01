import { readFile, readdir } from "node:fs/promises";
import { loadRuleSet } from "@belegbox/rules-engine";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MustangClient, type MustangValidateResponse } from "./mustang-client.js";
import { validateDocument } from "./pipeline.js";

const CORPUS = join(import.meta.dirname, "../../../corpus");

async function corpusFiles(): Promise<string[]> {
  const entries = await readdir(CORPUS);
  return entries.filter((f) => f.endsWith(".xml")).sort();
}

async function load(name: string) {
  return { filename: name, bytes: await readFile(join(CORPUS, name)) };
}

/** A mustang-svc that answers without a JVM, so CI can assert the wiring. */
function stubClient(response: Partial<MustangValidateResponse>): MustangClient {
  const body: MustangValidateResponse = {
    validatorConfigVersion: "test-config-0",
    mustangVersion: "test",
    l1: { ran: true, valid: true },
    l2: { ran: true, valid: true },
    findings: [],
    ...response,
  };
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  return new MustangClient({ baseUrl: "http://stub", fetchImpl });
}

describe("corpus snapshots", () => {
  it("every fixture produces a stable offline result", async () => {
    const files = await corpusFiles();
    expect(files.length).toBeGreaterThan(0);

    const summary: Record<string, unknown> = {};
    for (const name of files) {
      const r = await validateDocument(await load(name), { skipL1L2: true });
      summary[name] = {
        format: r.detection.format,
        syntax: r.detection.syntax,
        profile: r.detection.profile.name,
        legalClass: r.detection.profile.legalClass,
        status: r.status,
        verdict: r.verdict,
        codes: r.findings.map((f) => f.code),
      };
    }
    expect(summary).toMatchSnapshot();
  });
});

describe("verdict wiring", () => {
  it("reports form unknown when the validator is unreachable", async () => {
    // Nothing is listening on this port; the pipeline must not guess.
    const client = new MustangClient({ baseUrl: "http://127.0.0.1:1", timeoutMs: 500 });
    const r = await validateDocument(await load("xrechnung-ubl-valid-01.xml"), {
      client,
    });
    expect(r.verdict.form).toBe("unknown");
    expect(r.status).toBe("pending");
    expect(r.layers.l2_schematron.skippedReason).toMatch(/unreachable/);
  });

  it("passes both verdicts on a clean invoice", async () => {
    const r = await validateDocument(await load("xrechnung-ubl-valid-01.xml"), {
      client: stubClient({}),
    });
    expect(r.verdict).toEqual({ form: "pass", content: "pass" });
    expect(r.status).toBe("clean");
    expect(r.versions.validatorConfigVersion).toBe("test-config-0");
  });

  it("stops at the form verdict when L2 fails", async () => {
    const r = await validateDocument(await load("broken-br-co-15-01.xml"), {
      client: stubClient({
        l2: { ran: true, valid: false },
        findings: [
          {
            layer: "l2_schematron",
            code: "BR-CO-15",
            severity: "error",
            btRef: "BT-112",
            message:
              "[BR-CO-15] Invoice total amount with VAT (BT-112) = Invoice total amount without VAT (BT-109) + Invoice total VAT amount (BT-110)",
          },
        ],
      }),
    });
    expect(r.verdict.form).toBe("fail");
    expect(r.status).toBe("form_error");
    // Raw validator output is stored verbatim - that transparency is a feature.
    expect(r.findings[0]?.messageRaw).toContain("BR-CO-15");
    expect(r.findings[0]?.severity).toBe("form_error");
  });

  it("classifies ZUGFeRD MINIMUM as not_einvoice even when the validator says valid", async () => {
    const r = await validateDocument(await load("zugferd-minimum-01.xml"), {
      client: stubClient({}),
    });
    expect(r.status).toBe("not_einvoice");
    expect(r.verdict).toEqual({ form: "n_a", content: "n_a" });
    expect(r.findings.map((f) => f.code)).toContain("D-001");
    expect(r.findings.find((f) => f.code === "D-001")?.legalBasis).toBe(
      "§ 14 Abs. 1 UStG",
    );
  });

  it("records the pinned validator config on every finding (R-2)", async () => {
    const r = await validateDocument(await load("broken-br-co-15-01.xml"), {
      client: stubClient({
        l2: { ran: true, valid: false },
        findings: [
          { layer: "l2_schematron", code: "BR-CO-15", severity: "error", message: "x" },
        ],
      }),
    });
    for (const f of r.findings) {
      expect(f.versions.validatorConfigVersion).toBe("test-config-0");
      expect(f.versions.engineVersion).toBeTruthy();
    }
  });

  it("treats a PDF as not_einvoice rather than throwing", async () => {
    const r = await validateDocument({
      filename: "scan.pdf",
      bytes: Buffer.from("%PDF-1.7\n"),
    });
    expect(r.status).toBe("not_einvoice");
    expect(r.findings.map((f) => f.code)).toContain("D-000");
  });
});

describe("status when the form check could not run", () => {
  /**
   * Regression. `pending` used to win over `content_error`, so a document with
   * a confirmed content failure and an unreachable validator showed grey in
   * the inbox. Since mustang-svc is not wired yet, that was every content
   * error the product finds.
   */
  it("reports content_error rather than pending", async () => {
    const ruleSet = loadRuleSet(
      await readFile(join(import.meta.dirname, "../../../rulesets/gastro-de.yaml"), "utf8"),
    );
    const r = await validateDocument(await load("gastro-beverage-7pct-01.xml"), {
      skipL1L2: true,
      ruleSet,
    });

    expect(r.verdict.form).toBe("unknown");
    expect(r.verdict.content).toBe("fail");
    expect(r.status).toBe("content_error");
  });

  it("still reports pending when nothing is known either way", async () => {
    const r = await validateDocument(await load("xrechnung-ubl-valid-01.xml"), {
      skipL1L2: true,
    });
    expect(r.status).toBe("pending");
  });
});
