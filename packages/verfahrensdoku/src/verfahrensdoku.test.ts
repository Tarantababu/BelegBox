import { describe, expect, it } from "vitest";
import {
  canonicalise,
  generate,
  lintDocument,
  lintText,
  renderHtml,
  DokuError,
  type DokuInput,
} from "./index.js";

const BASE: DokuInput = {
  tenant: {
    id: "dc4be0df-f229-4593-aaf9-1e7738d3226a",
    name: "Şahin Döner GmbH",
    vatId: "DE123456789",
    taxNumber: "35123/45678",
    country: "DE",
    industry: "gastro",
    locale: "tr",
    createdAt: new Date("2026-02-14T09:00:00Z"),
    retentionPolicy: { invoices_years: 10, vouchers_years: 8 },
  },
  inbox: { address: "sahin-doener.a7f3@in.belegbox.de", active: true, senderAuthChecked: true },
  users: [
    { email: "mehmet@sahin-doener.example", role: "owner", mfaEnabled: true },
    { email: "buchhaltung@sahin-doener.example", role: "accountant", mfaEnabled: false },
    { email: "aylin@sahin-doener.example", role: "accountant", mfaEnabled: true },
  ],
  validator: {
    validatorConfigVersion: "v2026-01-31",
    validatorConfigSha256: "6a5a5911a421b25fbc423f62f93f894df7b236f5d73ca4f84bb222a945082704",
    kositVersion: "1.5.0",
    engineVersion: "0.1.0",
    versionsInArchive: ["v2026-01-31"],
  },
  ruleset: { id: "r-1", template: "gastro-de", version: 1, ruleCount: 4 },
  storage: {
    backend: "S3",
    bucket: "belegbox-archive-eu",
    objectLockMode: "COMPLIANCE",
    retentionYears: 10,
  },
  archive: {
    documentCount: 7,
    sealedDays: 3,
    firstSealedDay: "2026-08-19",
    lastSealedDay: "2026-08-28",
    latestRoot: "b91c0a2f".padEnd(64, "0"),
  },
  migrations: [
    { name: "0001_core", appliedAt: new Date("2026-02-14T08:00:00Z") },
    { name: "0007_password_reset", appliedAt: new Date("2026-08-01T08:00:00Z") },
  ],
  generatedAt: new Date("2026-09-01T10:00:00Z"),
  version: 1,
};

const input = (over: Partial<DokuInput> = {}): DokuInput => ({ ...BASE, ...over });

describe("conformity lint", () => {
  it("refuses the sentence that would make the document worse than none", () => {
    const findings = lintText("test", "Das Archiv ist GoBD-konform und revisionssicher.");
    expect(findings.length).toBeGreaterThanOrEqual(2);
  });

  it.each([
    "Belegbox erfüllt die gesetzlichen Anforderungen.",
    "Das Verfahren ist vom Finanzamt anerkannt.",
    "Wir bestätigen die ordnungsmäßige Aufbewahrung.",
    "Die Ablage ist prüfungssicher.",
    "Der Vorgang ist zertifiziert.",
    "Die Unveränderbarkeit ist garantiert.",
    "Sie müssen die Belege monatlich sichten.",
  ])("refuses %s", (sentence) => {
    expect(lintText("test", sentence)).not.toHaveLength(0);
  });

  it("permits a description of the mechanism", () => {
    expect(
      lintText(
        "test",
        "Objekte werden mit S3 Object Lock im Modus COMPLIANCE geschrieben; die Frist kann auch vom Kontoinhaber nicht verkürzt werden.",
      ),
    ).toHaveLength(0);
  });

  it("passes over the whole generated document", () => {
    // The guard that matters. Every rule above exists because the sentence it
    // catches reads well enough to survive a proofread.
    expect(lintDocument(generate(input()).sections)).toEqual([]);
  });

  it("judges what Belegbox wrote, not what the tenant is called", () => {
    // "Rechtssicher" trips a rule aimed at our own marketing. A business is
    // entitled to its name, and refusing to document it would be a bug.
    const doc = generate(
      input({ tenant: { ...BASE.tenant, name: "Rechtssicher Gastro GmbH" } }),
    );
    expect(doc.tenantName).toBe("Rechtssicher Gastro GmbH");
    expect(renderHtml(doc)).toContain("Rechtssicher Gastro GmbH");
  });
});

describe("structure", () => {
  it("follows the GoBD's own division", () => {
    const doc = generate(input());
    expect(doc.sections.map((s) => s.id)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(doc.sections.every((s) => s.gobd)).toBe(true);
  });

  it("names a source for every stated fact", () => {
    // A sentence nobody can trace back to a column is an assertion, not
    // evidence, and this document exists to be evidence.
    for (const section of generate(input()).sections) {
      for (const fact of section.facts) {
        expect(fact.source.kind).toBeTruthy();
      }
    }
  });

  it("marks each section with who is asserting it", () => {
    const doc = generate(input());
    const coverages = new Set(doc.sections.map((s) => s.coverage));
    expect(coverages.has("belegbox")).toBe(true);
    expect(coverages.has("shared")).toBe(true);
  });
});

describe("open items", () => {
  it("is a draft on generation, because Belegbox cannot answer for the business", () => {
    const doc = generate(input());
    expect(doc.complete).toBe(false);
    expect(doc.openItems.length).toBeGreaterThan(5);
  });

  it("flattens them in document order", () => {
    const doc = generate(input());
    const sectionIds = doc.openItems.map((item) => item.sectionId);
    expect([...sectionIds].sort()).toEqual(sectionIds);
  });

  it("asks about the channels Belegbox cannot see", () => {
    const ids = generate(input()).openItems.map((item) => item.id);
    expect(ids).toContain("andere-eingangskanaele");
    expect(ids).toContain("kasse");
  });

  it("says on the front page that it is a draft", () => {
    expect(renderHtml(generate(input()))).toContain("Entwurf");
  });
});

describe("facts follow the system, not a template", () => {
  it("describes the archive differently when Object Lock is off", () => {
    const locked = text(generate(input()));
    const unlocked = text(
      generate(input({ storage: { ...BASE.storage, objectLockMode: null } })),
    );

    expect(locked).toContain("COMPLIANCE");
    expect(unlocked).not.toContain("COMPLIANCE");
    // The honest sentence, rather than silence about a missing control.
    expect(unlocked).toContain("Eine technische Sperre gegen Löschen besteht damit nicht.");
  });

  it("says so when no ruleset is assigned", () => {
    const doc = generate(input({ ruleset: null }));
    expect(text(doc)).toContain("kein mandantenbezogener Regelsatz zugewiesen");
  });

  it("reports an empty archive chain without inventing a day", () => {
    const doc = generate(
      input({
        archive: {
          documentCount: 0,
          sealedDays: 0,
          firstSealedDay: null,
          lastSealedDay: null,
          latestRoot: null,
        },
      }),
    );
    expect(text(doc)).toContain("noch kein Tag versiegelt");
  });

  it("carries the pinned validator versions through (R-2)", () => {
    const rendered = renderHtml(generate(input()));
    expect(rendered).toContain("v2026-01-31");
    expect(rendered).toContain("1.5.0");
    expect(rendered).toContain(BASE.validator.validatorConfigSha256);
  });

  it("names the versions that actually judged the archive, not today's (R-2)", () => {
    const judged = text(
      generate(
        input({
          validator: { ...BASE.validator, versionsInArchive: ["v2025-11-15", "v2026-01-31"] },
        }),
      ),
    );
    expect(judged).toContain("v2025-11-15, v2026-01-31");

    // The pipeline's sentinel for "the validator was not reachable then". It is
    // a fact about those documents, not a missing value, and reads as one.
    const degraded = text(
      generate(input({ validator: { ...BASE.validator, versionsInArchive: ["unavailable"] } })),
    );
    expect(degraded).toContain("ohne erreichbaren Validator geprüft");

    const fresh = text(
      generate(input({ validator: { ...BASE.validator, versionsInArchive: [] } })),
    );
    expect(fresh).toContain("noch kein Beleg geprüft");
  });

  it("counts the accounts that carry a second factor", () => {
    expect(text(generate(input()))).toContain("2 von 3");
  });

  it("summarises roles in a stable order", () => {
    const shuffled = generate(
      input({ users: [...BASE.users].reverse() }),
    );
    expect(text(shuffled)).toContain("2 Buchhaltung, 1 Inhaber");
  });
});

describe("versioning", () => {
  it("is reproducible: same facts, same hash", () => {
    expect(generate(input()).contentHash).toBe(generate(input()).contentHash);
  });

  it("moves the hash when a documented fact moves", () => {
    const before = generate(input()).contentHash;
    const after = generate(
      input({ storage: { ...BASE.storage, objectLockMode: "GOVERNANCE" } }),
    ).contentHash;
    expect(after).not.toBe(before);
  });

  it("hashes the content, not the presentation", () => {
    // Canonicalising over the rendered HTML would make a changed margin look
    // like a changed process.
    const doc = generate(input());
    const canonical = canonicalise(doc.sections, doc.version, BASE.generatedAt, undefined);
    expect(canonical).not.toContain("<");
    expect(canonical).toContain("fact:validator_config");
    expect(canonical).toContain("system_config/versions.properties#validator.config.version");
  });

  it("refuses a later fassung with no predecessor to chain to", () => {
    expect(() => generate(input({ version: 2 }))).toThrow(DokuError);
  });

  it("chains to the previous fassung", () => {
    const first = generate(input());
    const second = generate(
      input({ version: 2, previousHash: first.contentHash, generatedAt: new Date("2026-10-01T10:00:00Z") }),
    );
    expect(second.previousHash).toBe(first.contentHash);
    expect(renderHtml(second)).toContain(first.contentHash);
  });

  it("refuses fassung zero", () => {
    expect(() => generate(input({ version: 0 }))).toThrow(DokuError);
  });
});

describe("rendering", () => {
  it("escapes tenant-controlled text", () => {
    const doc = generate(
      input({ tenant: { ...BASE.tenant, name: '<script>alert("x")</script>' } }),
    );
    const html = renderHtml(doc);
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("carries no external asset, because the document is archived as it stands", () => {
    const html = renderHtml(generate(input()));
    expect(html).not.toMatch(/<(link|img|script)\b/);
    expect(html).not.toContain("http://");
  });

  it("keeps the judgement with the Steuerberatung", () => {
    expect(renderHtml(generate(input()))).toContain(
      "beurteilt die Steuerberatung oder Wirtschaftsprüfung",
    );
  });

  it("shows every fact with its source", () => {
    const html = renderHtml(generate(input()));
    expect(html).toContain("Datenbank · archive_chain");
    expect(html).toContain("Mandantenkonfiguration · tenants.retention_policy");
    expect(html).toContain("versions.properties · kosit.validationtool.version");
  });
});

/** All prose in the document, for assertions about what it does and does not say. */
function text(doc: ReturnType<typeof generate>): string {
  return doc.sections
    .flatMap((s) => [...s.body.map((p) => p.text), ...s.facts.map((f) => `${f.label}: ${f.value}`)])
    .join("\n");
}

describe("layout", () => {
  it("keeps wide tables inside their own scroll container", () => {
    // A fact table with fixed millimetre columns pushed the whole page sideways
    // in a narrow window. The page body must never scroll horizontally.
    const html = renderHtml(generate(input()));
    expect(html).toContain('<div class="tw"><table>');
    expect(html).toContain("overflow-x: auto");
    expect(html).not.toMatch(/width:\s*\d+mm;\s*\}/);
  });
});
