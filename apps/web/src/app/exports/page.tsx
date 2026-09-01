import { redirect } from "next/navigation";
import { getTenant } from "../../lib/api";
import { Chrome } from "../nav";

export const dynamic = "force-dynamic";

function defaultPeriod(): { from: string; to: string } {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

/**
 * M-06. The monthly hand-off to the Steuerberater.
 *
 * Included in every paid tier - the PRD makes that a deliberate difference from
 * the competitor, who puts it behind their top plan. There is no upsell on this
 * screen and there should not be one.
 */
export default async function ExportsPage() {
  const tenant = await getTenant();
  if (!tenant) redirect("/login");

  const period = defaultPeriod();

  return (
    <div className="shell">
      <Chrome tenantName={tenant.name} current="exports" />

      <div className="pad">
        <h1>DATEV-Export</h1>
        <p className="sub">
          Buchungsstapel im Format EXTF, wie deine Steuerberatung ihn importiert.
        </p>
      </div>

      <form method="get" action="/exports/download">
        <div className="pad" style={{ paddingTop: 0 }}>
          <div className="field">
            <label htmlFor="from">Zeitraum von</label>
            <input id="from" name="from" type="date" defaultValue={period.from} required />
          </div>
          <div className="field">
            <label htmlFor="to">bis</label>
            <input id="to" name="to" type="date" defaultValue={period.to} required />
          </div>
          <div className="field">
            <label htmlFor="berater">Beraternummer</label>
            <input id="berater" name="berater" inputMode="numeric" required placeholder="1234567" />
            <p className="hint">
              Diese Nummern vergibt deine Steuerberatung. Ohne sie kann DATEV den Stapel
              nicht zuordnen.
            </p>
          </div>
          <div className="field">
            <label htmlFor="mandant">Mandantennummer</label>
            <input id="mandant" name="mandant" inputMode="numeric" required placeholder="42" />
          </div>
          <div className="field">
            <label htmlFor="chart">Kontenrahmen</label>
            <select id="chart" name="chart" defaultValue="SKR03">
              <option value="SKR03">SKR03</option>
              <option value="SKR04">SKR04</option>
            </select>
            <p className="hint">
              Der falsche Kontenrahmen erzeugt einen Stapel, den deine Steuerberatung Zeile
              für Zeile korrigieren muss.
            </p>
          </div>
          <button className="btn solid" type="submit">
            Stapel herunterladen
          </button>
        </div>
      </form>

      <div className="sec">
        <p className="note">
          Der Export ist in jedem bezahlten Tarif enthalten. Die Datei ist
          Windows-1252-kodiert und festgeschrieben, wie GoBD es für Buchungen
          vorsieht.
        </p>
      </div>

      <div className="sec">
        <h2>Belege zum Stapel</h2>
        <p className="sub">
          Die Originaldateien zum selben Zeitraum, als ZIP — genau die Bytes, die
          eingegangen sind. Ein Belegverzeichnis liegt bei, mit Prüfsumme und
          Archivtag zu jedem Beleg.
        </p>
      </div>

      <form method="get" action="/exports/belege">
        <div className="pad" style={{ paddingTop: 0 }}>
          <div className="field">
            <label htmlFor="belege-from">Zeitraum von</label>
            <input id="belege-from" name="from" type="date" defaultValue={period.from} required />
          </div>
          <div className="field">
            <label htmlFor="belege-to">bis</label>
            <input id="belege-to" name="to" type="date" defaultValue={period.to} required />
          </div>
          <button className="btn" type="submit">
            Belege herunterladen
          </button>
          <p className="hint">
            Belege, deren gespeicherte Bytes nicht mehr zu ihrer archivierten
            Prüfsumme passen, werden nicht beigelegt — sie stehen mit Grund im
            Belegverzeichnis.
          </p>
        </div>
      </form>
    </div>
  );
}
