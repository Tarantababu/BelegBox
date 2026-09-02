import { redirect } from "next/navigation";
import { getTenant } from "../../lib/api";
import { resolveUi } from "../../lib/i18n/server";
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
  const { t } = await resolveUi();

  const period = defaultPeriod();

  return (
    <div className="shell">
      <Chrome tenantName={tenant.name} current="exports" t={t} />

      <div className="pad">
        <h1>{t("exp.title")}</h1>
        <p className="sub">{t("exp.sub")}</p>
      </div>

      <form method="get" action="/exports/download">
        <div className="pad" style={{ paddingTop: 0 }}>
          <div className="field">
            <label htmlFor="from">{t("exp.from")}</label>
            <input id="from" name="from" type="date" defaultValue={period.from} required />
          </div>
          <div className="field">
            <label htmlFor="to">{t("exp.to")}</label>
            <input id="to" name="to" type="date" defaultValue={period.to} required />
          </div>
          <div className="field">
            {/* "Beraternummer" stays German in every language: it is the
                caption of the field the Steuerberatung will name on the phone,
                and a translated one is a number the user cannot ask for. */}
            <label htmlFor="berater">{t("exp.berater")}</label>
            <input id="berater" name="berater" inputMode="numeric" required placeholder="1234567" />
            <p className="hint">{t("exp.beraterHint")}</p>
          </div>
          <div className="field">
            <label htmlFor="mandant">{t("exp.mandant")}</label>
            <input id="mandant" name="mandant" inputMode="numeric" required placeholder="42" />
          </div>
          <div className="field">
            <label htmlFor="chart">{t("exp.chart")}</label>
            <select id="chart" name="chart" defaultValue="SKR03">
              <option value="SKR03">SKR03</option>
              <option value="SKR04">SKR04</option>
            </select>
            <p className="hint">{t("exp.chartHint")}</p>
          </div>
          <button className="btn solid" type="submit">
            {t("exp.download")}
          </button>
        </div>
      </form>

      <div className="sec">
        <p className="note">{t("exp.included")}</p>
      </div>

      <div className="sec">
        <h2>{t("exp.belegeTitle")}</h2>
        <p className="sub">{t("exp.belegeSub")}</p>
      </div>

      <form method="get" action="/exports/belege">
        <div className="pad" style={{ paddingTop: 0 }}>
          <div className="field">
            <label htmlFor="belege-from">{t("exp.from")}</label>
            <input id="belege-from" name="from" type="date" defaultValue={period.from} required />
          </div>
          <div className="field">
            <label htmlFor="belege-to">{t("exp.to")}</label>
            <input id="belege-to" name="to" type="date" defaultValue={period.to} required />
          </div>
          <button className="btn" type="submit">
            {t("exp.belegeDownload")}
          </button>
          <p className="hint">{t("exp.belegeHint")}</p>
        </div>
      </form>
    </div>
  );
}
