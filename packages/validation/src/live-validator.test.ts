import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadRuleSet } from "@belegbox/rules-engine";
import { describe, expect, it } from "vitest";
import { MustangClient } from "./mustang-client.js";
import { validateDocument } from "./pipeline.js";

/**
 * Runs against a live mustang-svc, and therefore against the real KoSIT
 * validator with the pinned XRechnung configuration.
 *
 * Skipped unless MUSTANG_SVC_URL is set, because it needs a JVM. CI starts the
 * service and sets it. Everything else in this package stubs the validator; this
 * is the only test that proves the form verdict actually comes from the tool the
 * public portals run.
 */
const URL = process.env["MUSTANG_SVC_URL"];
const suite = URL ? describe : describe.skip;

const ROOT = join(import.meta.dirname, "../../..");
const load = async (name: string) => ({
  filename: name,
  bytes: await readFile(join(ROOT, "corpus", name)),
});

suite("live KoSIT validation", () => {
  const client = () => new MustangClient({ baseUrl: URL as string, timeoutMs: 60_000 });

  it("passes a clean XRechnung in both syntaxes", async () => {
    for (const name of ["xrechnung-ubl-valid-01.xml", "xrechnung-cii-valid-01.xml"]) {
      const r = await validateDocument(await load(name), { client: client() });
      expect(r.verdict.form, name).toBe("pass");
      expect(r.status, name).toBe("clean");
    }
  });

  it("fails the form verdict on BR-CO-15 and names BT-112", async () => {
    const r = await validateDocument(await load("broken-br-co-15-01.xml"), { client: client() });

    expect(r.verdict.form).toBe("fail");
    expect(r.status).toBe("form_error");

    const finding = r.findings.find((f) => f.code === "BR-CO-15");
    expect(finding?.layer).toBe("l2_schematron");
    expect(finding?.severity).toBe("form_error");
    expect(finding?.btRef).toBe("BT-112");
    // The validator's own words, kept verbatim for anyone comparing our output
    // to a portal's.
    expect(finding?.messageRaw).toContain("BR-CO-15");
    // R-2: the configuration that produced this verdict travels with it.
    expect(finding?.versions.validatorConfigVersion).toMatch(/^v\d{4}-\d{2}-\d{2}$/);
  });

  /**
   * The case the product exists for. The official validator - the same engine
   * the ZRE and OZG-RE portals run - passes this invoice completely. It is
   * still wrong by 48,04 €, and only the content layer says so.
   */
  it("passes the form check and fails the content check on the beverage invoice", async () => {
    const ruleSet = loadRuleSet(await readFile(join(ROOT, "rulesets/gastro-de.yaml"), "utf8"));
    const r = await validateDocument(await load("gastro-beverage-7pct-01.xml"), {
      client: client(),
      ruleSet,
    });

    expect(r.verdict.form).toBe("pass");
    expect(r.verdict.content).toBe("fail");
    expect(r.status).toBe("content_error");

    const finding = r.findings.find((f) => f.code === "gastro-beverage-rate");
    expect(finding?.params["vat_gap"]).toBe(48.04);
    expect(finding?.legalBasis).toBe("§ 12 Abs. 2 Nr. 15 UStG");
  });

  it("catches the missing reverse-charge reason at L2 as well as L3", async () => {
    const r = await validateDocument(await load("missing-exemption-reason-ae-01.xml"), {
      client: client(),
    });
    // BR-AE-10 from the official Schematron, D-002 from our own domain layer.
    // Both are correct; the user sees the statute either way.
    expect(r.findings.map((f) => f.code)).toEqual(expect.arrayContaining(["BR-AE-10", "D-002"]));
  });

  it("does not run a form check on a document that is not an e-invoice", async () => {
    const r = await validateDocument(await load("zugferd-minimum-01.xml"), { client: client() });
    expect(r.verdict.form).toBe("n_a");
    expect(r.status).toBe("not_einvoice");
    expect(r.layers.l1_schema.skippedReason).toMatch(/not an e-invoice/);
  });
});
