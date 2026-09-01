import { SetupForm } from "./form";

export default function SetupPage() {
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
        <h1>Einrichtung</h1>
        <p className="sub">
          Drei Angaben, keine Kreditkarte. Am Ende steht deine Adresse für
          E-Rechnungen.
        </p>
      </div>

      <SetupForm />

      <div className="sec">
        <div className="warnbox">
          Seit dem 1. Januar 2025 dürfen Lieferanten E-Rechnungen senden, ohne
          vorher zu fragen. Die Pflicht, sie zu empfangen und lesbar zu
          archivieren, gilt damit schon heute — unabhängig davon, ab wann du
          selbst E-Rechnungen ausstellen musst.
        </div>
      </div>
    </div>
  );
}
