import { createHash } from "node:crypto";
import { lintText, type LintFinding } from "./lint.js";
import { buildSections, germanDate, germanDateTime, prose } from "./sections.js";
import {
  DokuError,
  type DokuInput,
  type OpenItem,
  type Section,
  type Verfahrensdokumentation,
} from "./types.js";

/**
 * Builds the document.
 *
 * A pure function of its input, deliberately: the same facts produce the same
 * bytes and therefore the same hash, which is what lets a later version's
 * `previousHash` mean anything. Nothing here reads the clock or the database -
 * `generatedAt` is passed in.
 */

/**
 * The change history GoBD Rz. 154 asks for.
 *
 * Built here rather than in sections.ts because it describes the document
 * itself, not the process: which version this is, when it was produced, and
 * which version it follows.
 */
function historySection(input: DokuInput): Section {
  const chained = input.previousHash
    ? prose`Diese Fassung nimmt die Prüfsumme der Fassung ${input.version - 1} auf. Wird eine frühere Fassung nachträglich verändert, passt sie nicht mehr zu dem Wert, den die nachfolgende Fassung nennt.`
    : prose`Dies ist die erste Fassung; es gibt keine Vorgängerfassung, auf die verwiesen wird.`;

  return {
    id: "7",
    title: "Fassungen dieser Dokumentation",
    coverage: "belegbox",
    gobd: "GoBD Rz. 154",
    body: [
      prose`Die Verfahrensdokumentation wird bei jeder Änderung neu erzeugt und als neue Fassung abgelegt. Frühere Fassungen bleiben erhalten, denn maßgeblich ist die Fassung, die im jeweiligen Zeitraum gegolten hat.`,
      prose`Jede Fassung trägt eine Prüfsumme über ihren Inhalt und nennt die Prüfsumme der vorangegangenen Fassung.`,
      chained,
    ],
    facts: [
      {
        key: "doc_version",
        label: "Fassung",
        value: String(input.version),
        source: { kind: "database", table: "verfahrensdokumentationen" },
      },
      {
        key: "doc_generated",
        label: "Erzeugt am",
        value: germanDateTime(input.generatedAt),
        source: { kind: "database", table: "verfahrensdokumentationen" },
      },
      {
        key: "doc_previous",
        label: "Prüfsumme der Vorfassung",
        value: input.previousHash ?? "keine",
        source: { kind: "database", table: "verfahrensdokumentationen" },
      },
    ],
    openItems: [
      {
        id: "fassung-freigabe",
        sectionId: "7",
        question:
          "Wer im Unternehmen nimmt diese Fassung ab, und wo wird die Abnahme festgehalten?",
        why: "Die Verfahrensdokumentation ist die Erklärung des Unternehmens; sie braucht eine Person, die sie verantwortet.",
      },
    ],
  };
}

/**
 * Canonical form for the hash.
 *
 * Hashing the rendered HTML would tie the identity of a fassung to its
 * stylesheet: a changed margin would look like a changed process. The hash runs
 * over the content instead - section ids, prose, facts with their sources, open
 * items - in document order.
 */
export function canonicalise(
  sections: Section[],
  version: number,
  generatedAt: Date,
  previousHash: string | undefined,
): string {
  const lines: string[] = [
    `version:${version}`,
    `generatedAt:${generatedAt.toISOString()}`,
    `previousHash:${previousHash ?? ""}`,
  ];

  for (const s of sections) {
    lines.push(`section:${s.id}:${s.title}:${s.coverage}:${s.gobd ?? ""}`);
    for (const paragraph of s.body) lines.push(`body:${paragraph.text}`);
    for (const fact of s.facts) {
      lines.push(`fact:${fact.key}:${fact.label}:${fact.value}:${sourceKey(fact.source)}`);
    }
    for (const item of s.openItems) lines.push(`open:${item.id}:${item.question}`);
  }

  return lines.join("\n");
}

function sourceKey(source: Section["facts"][number]["source"]): string {
  switch (source.kind) {
    case "tenant_config":
      return `tenant_config/${source.column}`;
    case "system_config":
      return `system_config/${source.file}#${source.key}`;
    case "database":
      return `database/${source.table}`;
    case "code":
      return `code/${source.module}`;
  }
}

export function hashDocument(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Runs the conformity lint over everything the generator wrote.
 *
 * Over the authored words only. Fact values and interpolated names are read out
 * of the system, and refusing to document a tenant because of what it is called
 * would be a bug, not a safeguard.
 *
 * Exported so the caller can decide what to do; `generate` refuses outright.
 * A certifying sentence is not a warning - it is the one failure that makes the
 * document worse than no document.
 */
export function lintDocument(sections: Section[]): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const s of sections) {
    for (const [index, paragraph] of s.body.entries()) {
      // `authored`, not `text`: a tenant's own name is data, and data cannot be
      // an authoring mistake.
      findings.push(...lintText(`§${s.id} Absatz ${index + 1}`, paragraph.authored));
    }
    for (const item of s.openItems) {
      findings.push(...lintText(`§${s.id} ${item.id}`, `${item.question} ${item.why}`));
    }
  }
  return findings;
}

export function generate(input: DokuInput): Verfahrensdokumentation {
  if (input.version < 1) {
    throw new DokuError("Die erste Fassung ist Fassung 1.");
  }
  if (input.version > 1 && !input.previousHash) {
    // Without it the chain has a hole exactly where the history matters.
    throw new DokuError(
      `Fassung ${input.version} braucht die Prüfsumme der Vorfassung.`,
    );
  }

  const sections = [...buildSections(input), historySection(input)];

  const findings = lintDocument(sections);
  if (findings.length > 0) {
    throw new DokuError(
      `Die Dokumentation enthält bewertende Aussagen: ${findings
        .map((f) => `${f.where} "${f.text}" (${f.why})`)
        .join("; ")}`,
    );
  }

  const openItems: OpenItem[] = sections.flatMap((s) => s.openItems);
  const canonical = canonicalise(sections, input.version, input.generatedAt, input.previousHash);

  return {
    version: input.version,
    generatedAt: input.generatedAt.toISOString(),
    tenantName: input.tenant.name,
    sections,
    openItems,
    // Always false on generation. Belegbox cannot answer any open item, so a
    // freshly generated document is by construction a draft.
    complete: openItems.length === 0,
    previousHash: input.previousHash,
    contentHash: hashDocument(canonical),
  };
}

export { germanDate };
