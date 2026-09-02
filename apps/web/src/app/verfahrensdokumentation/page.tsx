import { redirect } from "next/navigation";
import { getTenant, listVerfahrensdoku } from "../../lib/api";
import { resolveUi } from "../../lib/i18n/server";
import { Chrome } from "../nav";

export const dynamic = "force-dynamic";

function shortDate(iso: string): string {
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
 *
 * The name is not translated in any language. It is what a Betriebsprüfer will
 * ask for by name, and a screen offering "documentazione procedurale" is a
 * screen the user cannot answer that question from. The description under it
 * explains what it is; the heading stays the word that gets asked for.
 */
export default async function VerfahrensdokuPage({
  searchParams,
}: {
  searchParams: Promise<{ fassung?: string; fehler?: string }>;
}) {
  const tenant = await getTenant();
  if (!tenant) redirect("/login");
  const { t } = await resolveUi();

  const [list, params] = await Promise.all([listVerfahrensdoku(), searchParams]);
  const versions = list?.versions ?? [];
  const chain = list?.chain;
  const latest = versions[0];

  return (
    <div className="shell">
      <Chrome tenantName={tenant.name} current="doku" t={t} />

      <div className="pad">
        <h1>{t("nav.doku")}</h1>
        <p className="sub">{t("doku.sub")}</p>
      </div>

      {params.fehler ? (
        <div className="pad" style={{ paddingTop: 0 }}>
          <p className="alert">{t("doku.failed", { error: params.fehler })}</p>
        </div>
      ) : null}

      {params.fassung ? (
        <div className="pad" style={{ paddingTop: 0 }}>
          <p className="ok">{t("doku.created", { n: params.fassung })}</p>
        </div>
      ) : null}

      <div className="pad" style={{ paddingTop: 0 }}>
        <form method="post" action="/verfahrensdokumentation/generate">
          <button className="btn solid" type="submit">
            {latest ? t("doku.generateNext") : t("doku.generateFirst")}
          </button>
        </form>
        <p className="hint">{t("doku.generateHint")}</p>
      </div>

      {latest && !latest.complete ? (
        <div className="sec">
          <p className="note">
            {t("doku.openItems", { n: latest.version, count: latest.openItems })}
          </p>
        </div>
      ) : null}

      {chain && !chain.ok ? (
        <div className="pad" style={{ paddingTop: 0 }}>
          <p className="alert">{t("doku.chainBroken", { n: chain.brokenAt ?? "?" })}</p>
        </div>
      ) : null}

      {versions.length === 0 ? (
        <div className="sec">
          <p className="note">{t("doku.none")}</p>
        </div>
      ) : (
        <table className="vers">
          <thead>
            <tr>
              <th>{t("doku.colVersion")}</th>
              <th>{t("doku.colDate")}</th>
              <th>{t("doku.colOpen")}</th>
              <th>{t("doku.colHash")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {versions.map((version) => (
              <tr key={version.version}>
                <td>{version.version}</td>
                <td>{shortDate(version.generatedAt)}</td>
                <td>{version.complete ? t("doku.openNone") : version.openItems}</td>
                <td className="mono">{version.contentHash.slice(0, 16)}…</td>
                <td>
                  <a href={`/verfahrensdokumentation/${version.version}`} target="_blank" rel="noreferrer">
                    {t("doku.view")}
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
