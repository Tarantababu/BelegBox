import Link from "next/link";
import { LoginForm } from "./form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reset?: string }>;
}) {
  const justReset = (await searchParams).reset === "done";

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
        <h1>Anmelden</h1>
        <p className="sub">Zugang zu deinem Rechnungseingang.</p>
      </div>

      {justReset ? (
        <div className="sec">
          <div className="warnbox">
            Dein Passwort wurde geändert. Alle anderen Sitzungen sind beendet.
          </div>
        </div>
      ) : null}

      <LoginForm />

      <div className="sec">
        <p className="note">
          <Link href="/reset" style={{ textDecoration: "underline" }}>Passwort vergessen?</Link>
        </p>
        <p className="note" style={{ marginTop: 8 }}>
          Noch kein Konto? <Link href="/setup" style={{ textDecoration: "underline" }}>Einrichtung starten</Link>
        </p>
      </div>
    </div>
  );
}
