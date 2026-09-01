import Link from "next/link";
import { RequestForm } from "./form";

export default function ResetRequestPage() {
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
        <h1>Passwort zurücksetzen</h1>
        <p className="sub">Wir schicken dir einen Link, mit dem du ein neues setzen kannst.</p>
      </div>

      <RequestForm />

      <div className="sec">
        <p className="note">
          <Link href="/login" style={{ textDecoration: "underline" }}>Zurück zur Anmeldung</Link>
        </p>
      </div>
    </div>
  );
}
