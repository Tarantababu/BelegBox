import { redirect } from "next/navigation";
import { getTenant, listVerfahrensdoku } from "../../lib/api";
import { Chrome } from "../nav";

export const dynamic = "force-dynamic";

function germanDate(iso: string): string {
  const date = new Date(iso);
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${day}.${month}.${date.getUTCFullYear()}`;
}

/**
 * M-11. The Verfahrensdokumentation.
 *
 * Fassungen, not a document. GoBD Rz. 154 cares about the one that was in force
 * during the period under review, so nothing here replaces anything - each
 * generation adds a fassung chained to the hash of the one before it.
 */
export default async function VerfahrensdokuPage({
  searchParams,
}: {
  searchParams: Promise<{ fassung?: string; fehler?: string }>;
}) {
  const tenant = await getTenant();
  if (!tenant) redirect("/login");

  const [list, params] = await Promise.all([listVerfahrensdoku(), searchParams]);
  const versions = list?.versions ?? [];
  const chain = list?.chain;
  const latest = versions[0];

  return (
    <div className="shell">
      <Chrome tenantName={tenant.name} current="doku" />

      <div className="pad">
        <h1>Verfahrensdokumentation</h1>
        <p className="sub">
          Beschreibt, wie Eingangsrechnungen bei euch ankommen, geprüft und aufbewahrt
          werden — mit Angabe, woher jede Angabe stammt.
        </p>
      </div>

      {params.fehler ? (
        <div className="pad" style={{ paddingTop: 0 }}>
          <p className="alert">
            Die Fassung konnte nicht erzeugt werden ({params.fehler}).
          </p>
        </div>
      ) : null}

      {params.fassung ? (
        <div className="pad" style={{ paddingTop: 0 }}>
          <p className="ok">Fassung {params.fassung} wurde erzeugt und abgelegt.</p>
        </div>
      ) : null}

      <div className="pad" style={{ paddingTop: 0 }}>
        <form method="post" action="/verfahrensdokumentation/generate">
          <button className="btn solid" type="submit">
            {latest ? "Neue Fassung erzeugen" : "Erste Fassung erzeugen"}
          </button>
        </form>
        <p className="hint">
          Jede Fassung hält den Stand des Systems zu ihrem Zeitpunkt fest. Frühere
          Fassungen bleiben erhalten.
        </p>
      </div>

      {latest && !latest.complete ? (
        <div className="sec">
          <p className="note">
            Fassung {latest.version} enthält {latest.openItems} Punkte, die nur ihr
            beantworten könnt — andere Eingangswege, Kassenführung, Vertretungsregelung.
            Belegbox kann sie nicht sehen und trägt sie deshalb nicht ein.
          </p>
        </div>
      ) : null}

      {chain && !chain.ok ? (
        <div className="pad" style={{ paddingTop: 0 }}>
          <p className="alert">
            Die Kette der Fassungen bricht bei Fassung {chain.brokenAt}.
          </p>
        </div>
      ) : null}

      {versions.length === 0 ? (
        <div className="sec">
          <p className="note">Es gibt noch keine Fassung.</p>
        </div>
      ) : (
        <table className="vers">
          <thead>
            <tr>
              <th>Fassung</th>
              <th>Stand</th>
              <th>Offene Punkte</th>
              <th>Prüfsumme</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {versions.map((version) => (
              <tr key={version.version}>
                <td>{version.version}</td>
                <td>{germanDate(version.generatedAt)}</td>
                <td>{version.complete ? "keine" : version.openItems}</td>
                <td className="mono">{version.contentHash.slice(0, 16)}…</td>
                <td>
                  <a href={`/verfahrensdokumentation/${version.version}`} target="_blank" rel="noreferrer">
                    Ansehen
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
