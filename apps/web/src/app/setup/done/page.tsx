import Link from "next/link";
import { redirect } from "next/navigation";
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
        <h1>Fast fertig.</h1>
        <p className="sub">
          Ein Schritt fehlt noch: die Zwei-Faktor-Anmeldung für dein Konto.
        </p>
      </div>

      <div className="sec">
        <div className="warnbox">
          Dieser Schlüssel wird nur jetzt angezeigt. Trage ihn in deine
          Authenticator-App ein, bevor du weitergehst — ohne ihn kommst du nicht
          in dein Konto.
        </div>
      </div>

      <div className="sec">
        <p className="lbl">Schlüssel für die Authenticator-App</p>
        <CopyBlock text={params.secret} mono />
        <p className="note" style={{ marginTop: 12 }}>
          Apps wie Aegis, 1Password oder Google Authenticator nehmen diesen
          Schlüssel direkt entgegen. Beim ersten Anmelden fragen wir nach dem
          sechsstelligen Code daraus.
        </p>
      </div>

      <div className="sec">
        <p className="lbl">Rechnungsadresse</p>
        <pre className="code" style={{ fontSize: 15 }}>
          {params.address}
        </pre>
        <p className="note" style={{ marginTop: 10 }}>
          Die zufällige Endung gehört dazu. Sie sorgt dafür, dass niemand die
          Adresse aus deinem Firmennamen erraten und dir eine gefälschte Rechnung
          zustellen kann.
        </p>
      </div>

      <div className="sec">
        <p className="lbl">Text für deine Lieferanten</p>
        <CopyBlock text={notice} />
      </div>

      <div className="sec">
        <Link className="btn solid" href="/login">
          Jetzt anmelden
        </Link>
      </div>
    </div>
  );
}
