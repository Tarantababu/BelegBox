import Link from "next/link";
import { redirect } from "next/navigation";
import { getTenant, searchArchive, type ArchiveSearch, type DocumentSummary } from "../../lib/api";
import { resolveUi } from "../../lib/i18n/server";
import type { Translate } from "../../lib/i18n";
import { day, money, STATUS_META } from "../../lib/status";
import { Chrome } from "../nav";

export const dynamic = "force-dynamic";

const PAGE = 25;

function Row({ doc, t }: { doc: DocumentSummary; t: Translate }) {
  const meta = STATUS_META[doc.status];
  // The same label the inbox shows, from the same key. Hardcoding German here
  // gave a Turkish tenant "Temiz" on one screen and "Sachfehler" on the next.
  return (
    <Link className="row" href={`/documents/${doc.id}`}>
      <span className={`spine ${meta.spine}`} />
      <span className="rmain">
        <b>{doc.supplier ?? t("common.unknownSender")}</b>
        <span>
          {doc.invoiceNumber ? `${doc.invoiceNumber} · ` : ""}
          {day(doc.issuedAt)}
        </span>
      </span>
      <span className="rside">
        <span className="amt">{money(doc.totalGross)}</span>
        <span className={`tag ${meta.spine}`}>{t(meta.key)}</span>
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
function Verdict({ result, term, t }: { result: ArchiveSearch; term: string; t: Translate }) {
  const count = result.totalIsLowerBound
    ? t("archive.over", { n: result.total })
    : `${result.total}`;
  const noun =
    !result.totalIsLowerBound && result.total === 1 ? t("archive.docOne") : t("archive.docMany");

  if (result.documents.length === 0) {
    return (
      <p className="note">
        {term ? t("archive.emptyTerm", { term }) : t("archive.emptyPeriod")}
      </p>
    );
  }

  if (result.mode === "similar") {
    return <p className="alert">{t("archive.similar", { term, count, noun })}</p>;
  }

  return (
    <p className="note">
      {count} {noun}
      {term ? t("archive.forTerm", { term }) : ""}
      {result.amount !== null ? t("archive.asAmount", { amount: money(result.amount) }) : ""}
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
  const { t } = await resolveUi();

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
      <Chrome tenantName={tenant.name} current="archiv" t={t} />

      <div className="pad">
        <h1>{t("archive.title")}</h1>
        <p className="sub">{t("archive.sub")}</p>
      </div>

      <form className="pad" style={{ paddingTop: 0 }} method="get" action="/archiv">
        <div className="field">
          <label htmlFor="q">{t("archive.qLabel")}</label>
          <input
            id="q"
            name="q"
            type="search"
            defaultValue={term}
            placeholder={t("archive.qPlaceholder")}
          />
        </div>
        <div className="row2">
          <div className="field">
            <label htmlFor="from">{t("archive.fromLabel")}</label>
            <input id="from" name="from" type="date" defaultValue={params.from ?? ""} />
          </div>
          <div className="field">
            <label htmlFor="to">{t("archive.toLabel")}</label>
            <input id="to" name="to" type="date" defaultValue={params.to ?? ""} />
          </div>
        </div>
        <div className="row2">
          <div className="field">
            <label htmlFor="status">{t("archive.statusLabel")}</label>
            {/* The same five words the rows and the inbox use. They used to be
                a second, lowercase set written only here, so a filter said
                "inhaltlicher Befund" for the status the row next to it called
                "Sachfehler". */}
            <select id="status" name="status" defaultValue={params.status ?? ""}>
              <option value="">{t("archive.statusAll")}</option>
              <option value="clean">{t("status.clean")}</option>
              <option value="form_error">{t("status.form_error")}</option>
              <option value="content_error">{t("status.content_error")}</option>
              <option value="not_einvoice">{t("status.not_einvoice")}</option>
              <option value="pending">{t("status.pending")}</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="min">{t("archive.amountLabel")}</label>
            <div className="row2">
              <input id="min" name="min" inputMode="decimal" defaultValue={params.min ?? ""} placeholder="0" />
              <input id="max" name="max" inputMode="decimal" defaultValue={params.max ?? ""} placeholder="∞" />
            </div>
          </div>
        </div>
        <button className="btn solid" type="submit">{t("common.search")}</button>
      </form>

      {result === null ? (
        <div className="sec">
          <p className="alert">{t("archive.unavailable")}</p>
        </div>
      ) : (
        <>
          <div className="sec">
            <Verdict result={result} term={term} t={t} />
          </div>

          {result.documents.map((doc) => (
            <Row key={doc.id} doc={doc} t={t} />
          ))}

          {(offset > 0 || result.documents.length === PAGE) && (
            <div className="pad pager">
              {offset > 0 ? (
                <Link className="btn" href={page(Math.max(offset - PAGE, 0))}>
                  {t("common.back")}
                </Link>
              ) : (
                <span />
              )}
              {result.documents.length === PAGE ? (
                <Link className="btn" href={page(offset + PAGE)}>
                  {t("common.next")}
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
