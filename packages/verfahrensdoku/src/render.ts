import { germanDate } from "./sections.js";
import type { Coverage, Fact, Section, Verfahrensdokumentation } from "./types.js";

/**
 * Renders the document to print-ready HTML.
 *
 * HTML rather than a PDF written here: the document has to be printed to
 * PDF/A-3 for the archive, and the conversion belongs where a PDF/A profile can
 * actually be applied. What this file guarantees is that the page breaks
 * sensibly, carries no external asset, and renders the same bytes for the same
 * document.
 *
 * The design does one job. An auditor reading it needs to see, per statement,
 * where the value came from and whether the business or the system is the one
 * asserting it. So every fact carries its source in the table beside it, and
 * every section carries a coverage badge.
 */

const COVERAGE_LABEL: Record<Coverage, string> = {
  belegbox: "aus dem System belegt",
  tenant: "vom Unternehmen zu beschreiben",
  shared: "teils belegt, teils zu ergänzen",
};

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sourceLabel(source: Fact["source"]): string {
  switch (source.kind) {
    case "tenant_config":
      return `Mandantenkonfiguration · ${source.column}`;
    case "system_config":
      return `${source.file} · ${source.key}`;
    case "database":
      return `Datenbank · ${source.table}`;
    case "code":
      return `Programmstand · ${source.module}`;
  }
}

/** Long hex runs break mid-token rather than pushing the table off the page. */
function factValue(value: string): string {
  const escaped = escapeHtml(value);
  return /^[0-9a-f]{32,}$/.test(value) ? `<span class="hash">${escaped}</span>` : escaped;
}

function renderSection(section: Section): string {
  const facts = section.facts.length
    ? `<div class="tw"><table>
          <thead><tr><th>Angabe</th><th>Wert</th><th>Quelle</th></tr></thead>
          <tbody>
${section.facts
  .map(
    (fact) => `            <tr>
              <th scope="row">${escapeHtml(fact.label)}</th>
              <td>${factValue(fact.value)}</td>
              <td class="src">${escapeHtml(sourceLabel(fact.source))}</td>
            </tr>`,
  )
  .join("\n")}
          </tbody>
        </table></div>`
    : "";

  const open = section.openItems.length
    ? `<div class="open">
          <p class="open-head">Vom Unternehmen zu ergänzen</p>
          <ul>
${section.openItems
  .map(
    (item) => `            <li><span class="q">${escapeHtml(item.question)}</span>
              <span class="why">${escapeHtml(item.why)}</span></li>`,
  )
  .join("\n")}
          </ul>
        </div>`
    : "";

  return `      <section>
        <h2><span class="num">${escapeHtml(section.id)}</span> ${escapeHtml(section.title)}</h2>
        <p class="meta">
          <span class="badge ${section.coverage}">${COVERAGE_LABEL[section.coverage]}</span>
${section.gobd ? `          <span class="gobd">${escapeHtml(section.gobd)}</span>` : ""}
        </p>
${section.body.map((paragraph) => `        <p>${escapeHtml(paragraph.text)}</p>`).join("\n")}
        ${facts}
        ${open}
      </section>`;
}

export function renderHtml(doc: Verfahrensdokumentation): string {
  const openCount = doc.openItems.length;

  const status = doc.complete
    ? `<p class="status done">Alle vorgesehenen Punkte sind beantwortet.</p>`
    : `<p class="status draft">Entwurf · ${openCount} ${
        openCount === 1 ? "Punkt ist" : "Punkte sind"
      } noch vom Unternehmen zu beantworten. Bis dahin beschreibt dieses Dokument nur den Teil des Verfahrens, der in Belegbox stattfindet.</p>`;

  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>Verfahrensdokumentation · ${escapeHtml(doc.tenantName)} · Fassung ${doc.version}</title>
<style>
  @page { size: A4; margin: 22mm 18mm; }
  :root {
    --ink: #16181d;
    --muted: #5b6270;
    --line: #d8dbe2;
    --draft: #8a5a00;
    --draft-bg: #fdf3e0;
    --done: #1f5c3d;
    --done-bg: #e9f4ee;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0 auto; max-width: 190mm; padding: 16mm 12mm;
    font: 10.5pt/1.55 "Charter", "Georgia", "Times New Roman", serif;
    color: var(--ink); background: #fff;
  }
  h1 { font-size: 19pt; line-height: 1.2; margin: 0 0 2mm; text-wrap: balance; }
  h2 {
    font-size: 12.5pt; margin: 0 0 1.5mm;
    padding-top: 6mm; border-top: 1px solid var(--line);
  }
  h2 .num { color: var(--muted); font-variant-numeric: tabular-nums; margin-right: 2mm; }
  section { page-break-inside: auto; margin-bottom: 7mm; }
  section h2 { page-break-after: avoid; }
  p { margin: 0 0 2.5mm; }
  .lede { color: var(--muted); font-size: 11pt; margin-bottom: 5mm; }
  .cover { border-bottom: 2px solid var(--ink); padding-bottom: 5mm; margin-bottom: 6mm; }
  .cover dl {
    display: grid; grid-template-columns: 42mm 1fr; gap: 1mm 4mm;
    margin: 4mm 0 0; font-size: 9.5pt;
  }
  .cover dt { color: var(--muted); }
  .cover dd { margin: 0; }
  .status { padding: 3mm 4mm; border-radius: 2px; font-size: 9.5pt; margin: 5mm 0 0; }
  .status.draft { background: var(--draft-bg); color: var(--draft); border-left: 3px solid var(--draft); }
  .status.done { background: var(--done-bg); color: var(--done); border-left: 3px solid var(--done); }
  .meta { display: flex; gap: 3mm; align-items: baseline; margin-bottom: 3mm; font-size: 8.5pt; }
  .badge {
    text-transform: uppercase; letter-spacing: .06em; font-size: 7.5pt;
    padding: .8mm 2mm; border: 1px solid var(--line); border-radius: 2px; color: var(--muted);
  }
  .badge.belegbox { border-color: var(--done); color: var(--done); }
  .badge.tenant { border-color: var(--draft); color: var(--draft); }
  .gobd { color: var(--muted); font-variant-numeric: tabular-nums; }
  /* Last resort for a very narrow window: the table scrolls, the page does
     not. Prints as a plain block, since overflow has no meaning on paper. */
  .tw { overflow-x: auto; margin: 3mm 0; }
  table {
    width: 100%; border-collapse: collapse;
    font-size: 9pt; page-break-inside: auto;
  }
  th, td { text-align: left; vertical-align: top; padding: 1.6mm 2mm; border-bottom: 1px solid var(--line); }
  thead th {
    font-size: 7.5pt; text-transform: uppercase; letter-spacing: .06em;
    color: var(--muted); border-bottom-width: 1.5px;
  }
  /* Percentages rather than millimetres: the same table has to hold on an A4
     page and in a narrow browser window, and fixed mm columns push the page
     sideways on the second. */
  tbody th { font-weight: 600; width: 30%; }
  td.src { color: var(--muted); font-size: 8pt; width: 30%; }
  tr { page-break-inside: avoid; }
  .hash { font-family: "SF Mono", "Menlo", monospace; font-size: 7.5pt; word-break: break-all; }
  .open { border-left: 3px solid var(--draft); background: var(--draft-bg); padding: 3mm 4mm; margin-top: 3mm; }
  .open-head {
    font-size: 7.5pt; text-transform: uppercase; letter-spacing: .06em;
    color: var(--draft); margin-bottom: 1.5mm;
  }
  .open ul { margin: 0; padding-left: 4mm; font-size: 9pt; }
  .open li { margin-bottom: 2mm; }
  .open .q { display: block; }
  .open .why { display: block; color: var(--muted); font-size: 8pt; }
  footer {
    margin-top: 8mm; padding-top: 4mm; border-top: 1px solid var(--line);
    font-size: 8.5pt; color: var(--muted);
  }
  @media print {
    body { padding: 0; max-width: none; }
    .tw { overflow-x: visible; }
  }
</style>
</head>
<body>
  <header class="cover">
    <h1>Verfahrensdokumentation</h1>
    <p class="lede">Elektronische Eingangsrechnungen bei ${escapeHtml(doc.tenantName)}</p>
    <dl>
      <dt>Fassung</dt><dd>${doc.version}</dd>
      <dt>Stand</dt><dd>${escapeHtml(germanDate(doc.generatedAt))}</dd>
      <dt>Prüfsumme</dt><dd><span class="hash">${escapeHtml(doc.contentHash)}</span></dd>
      <dt>Vorfassung</dt><dd>${
        doc.previousHash
          ? `<span class="hash">${escapeHtml(doc.previousHash)}</span>`
          : "keine"
      }</dd>
    </dl>
    ${status}
  </header>

${doc.sections.map(renderSection).join("\n")}

  <footer>
    <p>Erzeugt von Belegbox aus dem Stand des Systems zum genannten Zeitpunkt. Die
    Angaben stammen aus den in der Spalte „Quelle“ genannten Stellen.</p>
    <p>Dieses Dokument beschreibt Abläufe und technische Mechanismen. Ob das
    beschriebene Verfahren den steuerlichen Anforderungen des Unternehmens
    genügt, beurteilt die Steuerberatung oder Wirtschaftsprüfung des
    Unternehmens.</p>
  </footer>
</body>
</html>
`;
}
