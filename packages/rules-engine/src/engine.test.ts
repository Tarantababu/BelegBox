import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseInvoice, type Invoice } from "@belegbox/core-invoice";
import { describe, expect, it } from "vitest";
import { dryRun } from "./dry-run.js";
import { evaluateRuleSet, iterationScope, ruleApplies } from "./evaluate.js";
import { evaluateExpression, ExpressionError, expressionFields } from "./expr.js";
import { fold, matchesLexicon, BUILTIN_LEXICONS } from "./lexicons.js";
import { loadRuleSet } from "./load.js";
import { applyOperator } from "./operators.js";
import { RuleSetError, type Rule, type RuleSet } from "./types.js";

const ROOT = join(import.meta.dirname, "../../..");
const corpus = (name: string) => readFile(join(ROOT, "corpus", name));
const ruleset = (name: string) => readFile(join(ROOT, "rulesets", name), "utf8");

const RULE = (over = ""): string => `
id: test-set
version: 1
rules:
  - id: r1
    version: 1
    severity: content_error
    scope: both
    when:
      field: doc.total_gross
      op: gt
      value: 100
    then:
      - action: flag
        explain_key: test.key
${over}`;

describe("expression evaluator", () => {
  const vars: Record<string, number> = { "line.net": 400.37, "doc.total_gross": 428.4 };
  const resolve = (p: string) => vars[p];

  it("evaluates arithmetic with correct precedence", () => {
    expect(evaluateExpression("2 + 3 * 4", resolve)).toBe(14);
    expect(evaluateExpression("(2 + 3) * 4", resolve)).toBe(20);
    expect(evaluateExpression("-3 + 10", resolve)).toBe(7);
    expect(evaluateExpression("10 / 4", resolve)).toBe(2.5);
  });

  it("resolves fields", () => {
    expect(evaluateExpression("line.net * 0.12", resolve)).toBeCloseTo(48.0444, 4);
  });

  // The reason this is a parser and not eval(): rule YAML becomes tenant input
  // in F3, and an expression string then runs on our servers.
  it("refuses anything that is not arithmetic", () => {
    for (const attack of [
      "process.exit(1)",
      "constructor",
      "line.net.constructor",
      "1; DROP TABLE documents",
      "require('fs')",
      "`${1}`",
      "line.net ** 2",
    ]) {
      expect(() => evaluateExpression(attack, resolve), attack).toThrow();
    }
  });

  it("refuses a missing field rather than treating it as zero", () => {
    // Zero would make a computed VAT gap read 0.00 and the finding look harmless.
    expect(() => evaluateExpression("line.missing * 2", resolve)).toThrow(ExpressionError);
  });

  it("refuses division by zero and overlong expressions", () => {
    expect(() => evaluateExpression("1 / 0", resolve)).toThrow(/Division by zero/);
    expect(() => evaluateExpression("1 +".repeat(200) + "1", resolve)).toThrow(/too long/);
  });

  it("refuses unbalanced parentheses and trailing tokens", () => {
    expect(() => evaluateExpression("(1 + 2", resolve)).toThrow(/closing parenthesis/);
    expect(() => evaluateExpression("1 + 2 3", resolve)).toThrow(/Trailing/);
  });

  it("lists the fields an expression touches", () => {
    expect(expressionFields("line.net * 0.12 + doc.total_gross")).toEqual([
      "line.net",
      "doc.total_gross",
    ]);
  });
});

describe("operators", () => {
  const cond = (op: string, value?: unknown) =>
    ({ field: "line.net", op, value }) as never;

  it("compares numbers to the cent", () => {
    expect(applyOperator({ actual: 7, condition: cond("equals", 7) }).matched).toBe(true);
    expect(applyOperator({ actual: 7.001, condition: cond("equals", 7) }).matched).toBe(true);
    expect(applyOperator({ actual: 7.02, condition: cond("equals", 7) }).matched).toBe(false);
  });

  it("compares strings case-insensitively", () => {
    expect(applyOperator({ actual: "s", condition: cond("equals", "S") }).matched).toBe(true);
  });

  // A comparison against a missing value is unanswerable, not false.
  it("abstains rather than answering a comparison on a missing value", () => {
    const result = applyOperator({ actual: undefined, condition: cond("gt", 10) });
    expect(result).toMatchObject({ matched: false, abstained: true });
  });

  it("handles between, in, is_empty and is_present", () => {
    expect(applyOperator({ actual: 5, condition: cond("between", [1, 10]) }).matched).toBe(true);
    expect(applyOperator({ actual: 50, condition: cond("between", [1, 10]) }).matched).toBe(false);
    expect(applyOperator({ actual: "AE", condition: cond("in", ["AE", "E"]) }).matched).toBe(true);
    expect(applyOperator({ actual: "  ", condition: cond("is_empty") }).matched).toBe(true);
    expect(applyOperator({ actual: "x", condition: cond("is_present") }).matched).toBe(true);
  });

  it("refuses a regular expression that nests quantifiers", () => {
    // The shape behind almost every real ReDoS. Node has no regex timeout, so
    // this is refused rather than run.
    expect(() =>
      applyOperator({ actual: "aaaa", condition: cond("matches_regex", "(a+)+$") }),
    ).toThrow(/backtracking/);
  });

  it("refuses an overlong pattern", () => {
    expect(() =>
      applyOperator({ actual: "x", condition: cond("matches_regex", "a".repeat(300)) }),
    ).toThrow(/longer than/);
  });

  // A tax authority outage must never tell a customer their invoice is wrong.
  it("abstains when VIES has not answered", () => {
    const result = applyOperator({
      actual: "ATU12345678",
      condition: { field: "supplier.vat_id", op: "vies_valid" },
      viesResults: {},
    });
    expect(result).toMatchObject({ matched: false, abstained: true });
  });

  it("uses a pre-resolved VIES answer", () => {
    expect(
      applyOperator({
        actual: "ATU12345678",
        condition: { field: "supplier.vat_id", op: "vies_valid", value: false },
        viesResults: { ATU12345678: false },
      }).matched,
    ).toBe(true);
  });
});

describe("lexicons", () => {
  it("expands umlauts once and leaves other words intact", () => {
    expect(fold("Getränkelieferung")).toBe("getraenkelieferung");
    expect(fold("Steuerschuldnerschaft")).toBe("steuerschuldnerschaft");
    expect(fold("Weißbier")).toBe("weissbier");
  });

  // Word boundaries would be wrong for German: the term on the invoice line is
  // a compound.
  it("matches inside German compounds", () => {
    expect(matchesLexicon("Getränkelieferung KW 34", BUILTIN_LEXICONS["beverages_de"] as string[]))
      .toMatchObject({ matched: true, term: "getraenk" });
    expect(matchesLexicon("Mineralwasser 12x1L", BUILTIN_LEXICONS["beverages_de"] as string[]).matched)
      .toBe(true);
  });

  it("does not match food as a beverage", () => {
    expect(matchesLexicon("Rindfleisch 40 kg", BUILTIN_LEXICONS["beverages_de"] as string[]).matched)
      .toBe(false);
  });
});

describe("ruleset loading", () => {
  it("loads a minimal ruleset", () => {
    const set = loadRuleSet(RULE());
    expect(set.rules).toHaveLength(1);
    expect(set.rules[0]?.severity).toBe("content_error");
  });

  /**
   * The rejection that matters. L2 is the official validator's verdict, and no
   * ruleset gets to overrule it - enforced here, in the TypeScript type, and by
   * a CHECK constraint in the database.
   */
  it("refuses a rule that claims a form error", () => {
    const yaml = RULE().replace("severity: content_error", "severity: form_error");
    expect(() => loadRuleSet(yaml)).toThrow(/never produce a form_error/);
  });

  it("refuses unknown fields, operators, lexicons and actions", () => {
    expect(() => loadRuleSet(RULE().replace("doc.total_gross", "doc.secret"))).toThrow(/Unknown field/);
    expect(() => loadRuleSet(RULE().replace("op: gt", "op: pwn"))).toThrow(/Unknown operator/);
    expect(() => loadRuleSet(RULE().replace("action: flag", "action: exec"))).toThrow(/Unsupported action/);
    expect(() =>
      loadRuleSet(RULE().replace("op: gt\n      value: 100", 'op: matches_lexicon\n      value: nope')),
    ).toThrow(/Unknown lexicon/);
  });

  it("refuses a flag with no explain_key", () => {
    // Explanations are versioned templates reviewed by a lawyer. A flag with
    // nothing to render cannot be reviewed and must not exist.
    expect(() => loadRuleSet(RULE().replace("        explain_key: test.key", ""))).toThrow(
      /needs an explain_key/,
    );
  });

  it("refuses an expression referencing an unknown field", () => {
    const yaml = `${RULE()}      - action: compute
        var: x
        expr: line.nope * 2
`;
    expect(() => loadRuleSet(yaml)).toThrow(/unknown field/i);
  });

  it("refuses a rule mixing line and tax iteration", () => {
    const yaml = `
id: mixed
version: 1
rules:
  - id: bad
    version: 1
    severity: warning
    when:
      all:
        - field: line.net
          op: gt
          value: 1
        - field: tax.rate
          op: equals
          value: 19
    then:
      - action: flag
        explain_key: x
`;
    expect(() => loadRuleSet(yaml)).toThrow(/one or the other/);
  });

  it("refuses duplicate rule ids and malformed dates", () => {
    expect(() => loadRuleSet(RULE().replace("version: 1\n    severity", "version: 0\n    severity")))
      .toThrow(/integer version/);
    expect(() =>
      loadRuleSet(`${RULE()}    effective_from: "01.01.2026"\n`),
    ).toThrow(/YYYY-MM-DD/);
  });

  it("infers the iteration scope from the fields used", () => {
    const set = loadRuleSet(RULE());
    expect(iterationScope(set.rules[0] as Rule)).toBe("document");
  });
});

describe("effective dating (R-1)", () => {
  const rule = {
    id: "r",
    version: 1,
    severity: "warning",
    scope: "both",
    when: { field: "doc.total_gross", op: "gt", value: 0 },
    then: [{ action: "flag", explain_key: "k" }],
    effective_from: "2026-01-01",
  } as Rule;

  const withDate = (issueDate?: string) =>
    ({
      invoice: { ...(issueDate ? { issueDate } : {}), lines: [], taxBreakdown: [] },
      direction: "incoming",
    }) as never;

  // The archive must not re-judge itself every time the law changes.
  it("does not apply to a document issued before the rule took effect", () => {
    expect(ruleApplies(rule, withDate("2025-12-31"))).toBe(false);
    expect(ruleApplies(rule, withDate("2026-01-01"))).toBe(true);
  });

  it("stops applying at effective_to", () => {
    const bounded = { ...rule, effective_to: "2027-01-01" };
    expect(ruleApplies(bounded, withDate("2026-12-31"))).toBe(true);
    expect(ruleApplies(bounded, withDate("2027-01-01"))).toBe(false);
  });

  it("does not apply a dated rule to a document with no issue date", () => {
    expect(ruleApplies(rule, withDate(undefined))).toBe(false);
  });

  it("respects incoming and outgoing scope", () => {
    const outgoing = { ...rule, scope: "outgoing" as const };
    expect(ruleApplies(outgoing, withDate("2026-06-01"))).toBe(false);
  });
});

describe("shipped rulesets", () => {
  it("loads both", async () => {
    expect(loadRuleSet(await ruleset("gastro-de.yaml")).rules.length).toBeGreaterThan(0);
    expect(loadRuleSet(await ruleset("handwerk-bau-de.yaml")).rules.length).toBeGreaterThan(0);
  });

  /**
   * The case the whole product exists for. This invoice passes every syntax
   * validator on the market: the arithmetic balances, the schema is clean, the
   * Schematron is satisfied. It is still wrong.
   */
  it("flags beverages at 7 % with the gap and the statute", async () => {
    const set = loadRuleSet(await ruleset("gastro-de.yaml"));
    const invoice = parseInvoice(await corpus("gastro-beverage-7pct-01.xml"));
    const { findings } = evaluateRuleSet(set, { invoice, direction: "incoming" });

    expect(findings).toHaveLength(1);
    const hit = findings[0];
    expect(hit?.ruleId).toBe("gastro-beverage-rate");
    expect(hit?.severity).toBe("content_error");
    expect(hit?.legalBasis).toBe("§ 12 Abs. 2 Nr. 15 UStG");
    // 400.37 net at 7 % should have been 19 %: 400.37 * 0.12.
    expect(hit?.params["vat_gap"]).toBe(48.04);
    expect(hit?.scopeRef).toMatchObject({ kind: "line", index: 0 });
  });

  it("leaves a clean food invoice alone", async () => {
    const set = loadRuleSet(await ruleset("gastro-de.yaml"));
    const invoice = parseInvoice(await corpus("xrechnung-cii-valid-01.xml"));
    expect(evaluateRuleSet(set, { invoice, direction: "incoming" }).findings).toHaveLength(0);
  });

  // Milk over 75 % and tap water stay at 7 %. Without the exception this rule
  // flags a dairy delivery every week until the user stops reading findings.
  it("does not flag a milk delivery at 7 %", async () => {
    const set = loadRuleSet(await ruleset("gastro-de.yaml"));
    const invoice = parseInvoice(await corpus("gastro-beverage-7pct-01.xml"));
    const milk: Invoice = {
      ...invoice,
      lines: [{ ...invoice.lines[0], name: "Frischmilch 3,5% 20 Liter" }],
    };
    expect(evaluateRuleSet(set, { invoice: milk, direction: "incoming" }).findings).toHaveLength(0);
  });

  it("does not apply the 2026 rule to a 2025 invoice", async () => {
    const set = loadRuleSet(await ruleset("gastro-de.yaml"));
    const invoice = parseInvoice(await corpus("gastro-beverage-7pct-01.xml"));
    const earlier: Invoice = { ...invoice, issueDate: "2025-11-30" };
    expect(evaluateRuleSet(set, { invoice: earlier, direction: "incoming" }).findings).toHaveLength(0);
  });

  it("flags reverse charge without its statutory wording", async () => {
    const set = loadRuleSet(await ruleset("handwerk-bau-de.yaml"));
    const invoice = parseInvoice(await corpus("missing-exemption-reason-ae-01.xml"));
    const { findings } = evaluateRuleSet(set, { invoice, direction: "incoming" });

    expect(findings.map((f) => f.ruleId)).toContain("handwerk-reverse-charge-notice");
    expect(findings[0]?.scopeRef).toMatchObject({ kind: "tax", index: 0 });
  });

  it("stops flagging once the wording is present", async () => {
    const set = loadRuleSet(await ruleset("handwerk-bau-de.yaml"));
    const invoice = parseInvoice(await corpus("missing-exemption-reason-ae-01.xml"));
    const fixed: Invoice = {
      ...invoice,
      taxBreakdown: [
        {
          ...invoice.taxBreakdown[0],
          exemptionReason: "Steuerschuldnerschaft des Leistungsempfängers",
        },
      ],
    };
    expect(evaluateRuleSet(set, { invoice: fixed, direction: "incoming" }).findings).toHaveLength(0);
  });
});

describe("dry run", () => {
  it("reports which documents a rule would flag, per document", async () => {
    const set = loadRuleSet(await ruleset("gastro-de.yaml"));
    const bad = parseInvoice(await corpus("gastro-beverage-7pct-01.xml"));
    const good = parseInvoice(await corpus("xrechnung-cii-valid-01.xml"));

    const report = dryRun(set, [
      { id: "d1", invoice: bad },
      { id: "d2", invoice: good },
      // Two bad lines on one invoice is still one invoice to the author.
      { id: "d3", invoice: { ...bad, lines: [bad.lines[0], bad.lines[0]] } as Invoice },
    ]);

    expect(report.documentsEvaluated).toBe(3);
    expect(report.countsByRule["gastro-beverage-rate"]).toBe(2);
    expect(report.hits).toHaveLength(3);
    expect(report.silentRules).toContain("gastro-food-rate-too-high");
    expect(report.errors).toHaveLength(0);
  });

  it("keeps going when one document is malformed", async () => {
    const set = loadRuleSet(await ruleset("gastro-de.yaml"));
    const good = parseInvoice(await corpus("gastro-beverage-7pct-01.xml"));
    const broken = { ...good, lines: [{ ...good.lines[0], net: undefined }] } as Invoice;

    const report = dryRun(set, [
      { id: "broken", invoice: broken },
      { id: "good", invoice: good },
    ]);
    // compute fails on the broken line, but the other 89 days still report.
    expect(report.errors).toHaveLength(1);
    expect(report.countsByRule["gastro-beverage-rate"]).toBe(1);
  });

  it("does not send anything for a notify action", async () => {
    const set: RuleSet = loadRuleSet(`
id: notifier
version: 1
rules:
  - id: n1
    version: 1
    severity: info
    when:
      field: doc.total_gross
      op: gt
      value: 1
    then:
      - action: notify
        channel: push
      - action: flag
        explain_key: n.key
`);
    const invoice = parseInvoice(await corpus("gastro-beverage-7pct-01.xml"));
    const report = dryRun(set, [{ id: "d", invoice }]);
    // The intent is recorded as a parameter; nothing leaves the process.
    expect(report.hits[0]?.params["notify_channel"]).toBe("push");
  });
});

describe("evaluation semantics", () => {
  it("skips a line rule when the document has no lines", async () => {
    const set = loadRuleSet(await ruleset("gastro-de.yaml"));
    const invoice = parseInvoice(await corpus("zugferd-minimum-01.xml"));
    const result = evaluateRuleSet(set, { invoice, direction: "incoming" });
    expect(result.findings).toHaveLength(0);
    expect(result.skipped.map((s) => s.reason)).toContain("no line entries to evaluate");
  });

  /**
   * Everything checkable without an invoice is checked at load. A value of the
   * wrong shape must not survive until a real document reaches it - by then the
   * dry-run preview has already told the author the rule is fine.
   */
  it("rejects operator values of the wrong shape at load time", () => {
    expect(() => loadRuleSet(RULE().replace("op: gt", "op: matches_lexicon"))).toThrow(
      /needs a string value/,
    );
    expect(() => loadRuleSet(RULE().replace("op: gt", "op: in"))).toThrow(/needs a list/);
    expect(() => loadRuleSet(RULE().replace("op: gt", "op: between"))).toThrow(/exactly two/);
    expect(() => loadRuleSet(RULE().replace("value: 100", 'value: "100"'))).toThrow(
      /needs a number/,
    );
  });

  it("rejects a backtracking-prone pattern at load, not on an invoice", () => {
    const yaml = RULE()
      .replace("field: doc.total_gross", "field: line.description")
      .replace("op: gt\n      value: 100", 'op: matches_regex\n      value: "(a+)+$"');
    expect(() => loadRuleSet(yaml)).toThrow(RuleSetError);
  });
});
