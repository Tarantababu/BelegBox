import Link from "next/link";
import { redirect } from "next/navigation";
import { getInbox, getTenant, type DocumentSummary } from "../../lib/api";
import { day, money, STATUS_META } from "../../lib/status";
import { Chrome } from "../nav";

export const dynamic = "force-dynamic";

function Row({ doc, locale }: { doc: DocumentSummary; locale: string }) {
  const meta = STATUS_META[doc.status];
  const label = locale === "tr" ? meta.tr : meta.de;

  return (
    <Link className="row" href={`/documents/${doc.id}`}>
      <span className={`spine ${meta.spine}`} />
      <span className="rmain">
        <b>{doc.supplier ?? "Unbekannter Absender"}</b>
        <span>
          {doc.invoiceNumber ? `${doc.invoiceNumber} · ` : ""}
          {day(doc.issuedAt)}
          {doc.format ? ` · ${doc.format.replace(/_/g, " ")}` : ""}
        </span>
      </span>
      <span className="rside">
        <span className="amt">{money(doc.totalGross)}</span>
        <span className={`tag ${meta.spine}`}>{label}</span>
      </span>
    </Link>
  );
}

export default async function Inbox({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  const tenant = await getTenant();
  if (!tenant) redirect("/setup");

  const params = await searchParams;
  const inbox = await getInbox({
    ...(params.status ? { status: params.status } : {}),
    ...(params.q ? { q: params.q } : {}),
  });
  const documents = inbox?.documents ?? [];
  const counts = inbox?.counts ?? {};

  const needsAttention = (counts["form_error"] ?? 0) + (counts["content_error"] ?? 0);
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

  return (
    <div className="shell">
      <Chrome tenantName={tenant.name} current={params.status === "clean" ? "archive" : "inbox"} />

      <div className="stats">
        <div className="stat">
          <b>{total}</b>
          <span>Belege gesamt</span>
        </div>
        <div className="stat w">
          <b>{needsAttention}</b>
          <span>Zu prüfen</span>
        </div>
        <div className="stat">
          <b>{counts["not_einvoice"] ?? 0}</b>
          <span>Keine E-Rechnung</span>
        </div>
      </div>

      <form className="bar" method="get">
        {params.status ? <input type="hidden" name="status" value={params.status} /> : null}
        <input
          type="search"
          name="q"
          defaultValue={params.q ?? ""}
          placeholder="Lieferant oder Rechnungsnummer suchen"
          aria-label="Suchen"
        />
        <button className="btn" type="submit">
          Suchen
        </button>
      </form>

      {documents.length > 0 ? (
        documents.map((doc) => <Row key={doc.id} doc={doc} locale={tenant.locale} />)
      ) : (
        /* An empty state is an invitation, not an apology (PRD § 5.3). It
           answers the only question a new user has here: what do I do now? */
        <div className="empty">
          <b>Noch nichts angekommen.</b>
          Neue E-Rechnungen landen automatisch hier, sobald ein Lieferant an
          deine Adresse sendet:
          <pre className="code">{tenant.inboxAddress}</pre>
        </div>
      )}
    </div>
  );
}
