import Link from "next/link";
import { redirect } from "next/navigation";
import { resolvePublicUi } from "../../../lib/i18n/server";
import { CopyBlock } from "./copy";

/**
 * Shown once, immediately after setup.
 *
 * The enrolment secret arrives in the query string and is never stored on this
 * side. Reload it later and it is gone - which is the correct behaviour for a
 * shared secret, and the reason the page says so plainly.
 */
export default async function SetupDone({
  searchParams,
}: {
  searchParams: Promise<{ address?: string; secret?: string; uri?: string; email?: string }>;
}) {
  const params = await searchParams;
  if (!params.address || !params.secret) redirect("/setup");
  const { t, dict } = await resolvePublicUi();

  // German whatever the interface language is: this is a letter to a German
  // supplier, and translating it would hand the user a text their supplier
  // cannot act on. The heading above it says why it is in German.
  const notice = [
    "Sehr geehrte Damen und Herren,",
    "",
    "wir empfangen E-Rechnungen ab sofort unter folgender Adresse:",
    "",
    `    ${params.address}`,
    "",
    "Bitte senden Sie künftige Rechnungen als XRechnung (UBL oder CII) oder als",
    "ZUGFeRD/Factur-X ab Profil EN 16931 an diese Adresse. Die ZUGFeRD-Profile",
    "MINIMUM und BASIC WL enthalten keine Daten auf Positionsebene und gelten",
    "nicht als E-Rechnung.",
  ].join("\n");

  return (
    <div className="shell">
      <header className="top">
        <div className="hrow">
          <span className="mark">
            <i />
            Belegbox
          </span>
        </div>
      </header>

      <div className="pad">
        <h1>{t("done.title")}</h1>
        <p className="sub">{t("done.sub")}</p>
      </div>

      <div className="sec">
        <div className="warnbox">{t("done.warn")}</div>
      </div>

      <div className="sec">
        <p className="lbl">{t("done.secretLabel")}</p>
        <CopyBlock text={params.secret} mono dict={dict} />
        <p className="note" style={{ marginTop: 12 }}>
          {t("done.secretNote")}
        </p>
      </div>

      <div className="sec">
        <p className="lbl">{t("done.addressLabel")}</p>
        <pre className="code" style={{ fontSize: 15 }}>
          {params.address}
        </pre>
        <p className="note" style={{ marginTop: 10 }}>
          {t("done.addressNote")}
        </p>
      </div>

      <div className="sec">
        <p className="lbl">{t("done.noticeLabel")}</p>
        <CopyBlock text={notice} dict={dict} />
      </div>

      <div className="sec">
        <Link className="btn solid" href="/login">
          {t("done.signIn")}
        </Link>
      </div>
    </div>
  );
}
