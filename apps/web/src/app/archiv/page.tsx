import Link from "next/link";
import { redirect } from "next/navigation";
import { getTenant, searchArchive, type ArchiveSearch, type DocumentSummary } from "../../lib/api";
import { day, money, STATUS_META } from "../../lib/status";
import { Chrome } from "../nav";

export const dynamic = "force-dynamic";

const PAGE = 25;

function Row({ doc, locale }: { doc: DocumentSummary; locale: string }) {
  const meta = STATUS_META[doc.status];
  // The same label the inbox shows. Hardcoding German here gave a Turkish
  // tenant "Temiz" on one screen and "Sachfehler" on the next.
  const label = locale === "tr" ? meta.tr : meta.de;
  return (
    <Link className="row" href={`/documents/${doc.id}`}>
      <span className={`spine ${meta.spine}`} />
      <span className="rmain">
        <b>{doc.supplier ?? "Unbekannter Absender"}</b>
        <span>
          {doc.invoiceNumber ? `${doc.invoiceNumber} · ` : ""}
          {day(doc.issuedAt)}
        </span>
      </span>
      <span className="rside">
        <span className="amt">{money(doc.totalGross)}</span>
        <span className={`tag ${meta.spine}`}>{label}</span>
      </span>
    </Link>
  );
}

/**
 * What the result set actually is.
 *
 * The distinction between "nothing like this is in the archive" and "nothing
 * matched exactly, here is what is close" is the whole point of the screen. Ten
 * years in, a user who reads the second as the first concludes an invoice was
 * never received.
 */
function Verdict({ result, term }: { result: ArchiveSearch; term: string }) {
  const count = result.totalIsLowerBound ? `über ${result.total}` : `${result.total}`;
  const noun = !result.totalIsLowerBound && result.total === 1 ? "Beleg" : "Belege";

  if (result.documents.length === 0) {
    return (
      <p className="note">
        {term
          ? `Kein Beleg zu „${term}“ im Archiv — auch keiner mit ähnlicher Schreibweise.`
          : "Keine Belege in diesem Zeitraum."}
      </p>
    );
  }

  if (result.mode === "similar") {
    return (
      <p className="alert">
        Keine genaue Übereinstimmung mit „{term}“. {count} {noun} mit ähnlicher
        Schreibweise:
      </p>
    );
  }

  return (
    <p className="note">
      {count} {noun}
      {term ? ` zu „${term}“` : ""}
      {result.amount !== null ? ` — als Betrag gelesen: ${money(result.amount)}` : ""}
    </p>
  );
}

/**
 * M-05. Search across ten years.
 *
 * Period is the document's own issue date, not when it arrived: a
 * Steuerberater asking for 2025 means invoices dated 2025.
 */
export default async function ArchivePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const tenant = await getTenant();
  if (!tenant) redirect("/login");

  const params = await searchParams;
  const term = params.q ?? "";
  const offset = Math.max(Number(params.offset ?? 0) || 0, 0);

  const result = await searchArchive({
    q: term,
    status: params.status ?? "",
    from: params.from ?? "",
    to: params.to ?? "",
    min: params.min ?? "",
    max: params.max ?? "",
    limit: String(PAGE),
    offset: String(offset),
  });

  const page = (next: number): string => {
    const query = new URLSearchParams(
      Object.entries({ ...params, offset: String(next) }).filter(
        ([, value]) => value !== undefined && value !== "",
      ) as [string, string][],
    );
    return `/archiv?${query.toString()}`;
  };

  return (
    <div className="shell">
      <Chrome tenantName={tenant.name} current="archiv" />

      <div className="pad">
        <h1>Archiv</h1>
        <p className="sub">
          Alle Belege, auch die aus früheren Jahren. Namen werden in jeder
          Schreibweise gefunden — Şahin, Sahin, Getränke, Getraenke.
        </p>
      </div>

      <form className="pad" style={{ paddingTop: 0 }} method="get" action="/archiv">
        <div className="field">
          <label htmlFor="q">Lieferant, Rechnungsnummer, USt-IdNr. oder Betrag</label>
          <input id="q" name="q" type="search" defaultValue={term} placeholder="z. B. Müller, GM-88213, 428,40" />
        </div>
        <div className="row2">
          <div className="field">
            <label htmlFor="from">Rechnungsdatum von</label>
            <input id="from" name="from" type="date" defaultValue={params.from ?? ""} />
          </div>
          <div className="field">
            <label htmlFor="to">bis</label>
            <input id="to" name="to" type="date" defaultValue={params.to ?? ""} />
          </div>
        </div>
        <div className="row2">
          <div className="field">
            <label htmlFor="status">Status</label>
            <select id="status" name="status" defaultValue={params.status ?? ""}>
              <option value="">alle</option>
              <option value="clean">geprüft</option>
              <option value="form_error">Formfehler</option>
              <option value="content_error">inhaltlicher Befund</option>
              <option value="not_einvoice">keine E-Rechnung</option>
              <option value="pending">in Prüfung</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="min">Betrag von / bis</label>
            <div className="row2">
              <input id="min" name="min" inputMode="decimal" defaultValue={params.min ?? ""} placeholder="0" />
              <input id="max" name="max" inputMode="decimal" defaultValue={params.max ?? ""} placeholder="∞" />
            </div>
          </div>
        </div>
        <button className="btn solid" type="submit">Suchen</button>
      </form>

      {result === null ? (
        <div className="sec">
          <p className="alert">Die Suche ist gerade nicht erreichbar.</p>
        </div>
      ) : (
        <>
          <div className="sec">
            <Verdict result={result} term={term} />
          </div>

          {result.documents.map((doc) => (
            <Row key={doc.id} doc={doc} locale={tenant.locale} />
          ))}

          {(offset > 0 || result.documents.length === PAGE) && (
            <div className="pad pager">
              {offset > 0 ? (
                <Link className="btn" href={page(Math.max(offset - PAGE, 0))}>
                  Zurück
                </Link>
              ) : (
                <span />
              )}
              {result.documents.length === PAGE ? (
                <Link className="btn" href={page(offset + PAGE)}>
                  Weiter
                </Link>
              ) : (
                <span />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
