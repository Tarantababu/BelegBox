import Link from "next/link";
import { LoginForm } from "./form";

export default function LoginPage() {
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

      <LoginForm />

      <div className="sec">
        <p className="note">
          Noch kein Konto? <Link href="/setup" style={{ textDecoration: "underline" }}>Einrichtung starten</Link>
        </p>
      </div>
    </div>
  );
}
