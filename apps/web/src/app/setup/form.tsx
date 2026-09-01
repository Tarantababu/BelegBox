"use client";

import { useActionState } from "react";
import { setupAction, type SetupState } from "./actions";

const SECTORS = [
  { value: "", label: "Bitte wählen" },
  { value: "gastro-de", label: "Gastronomie" },
  { value: "handwerk-bau-de", label: "Handwerk und Bau" },
  { value: "logistik-de", label: "Logistik und Transport" },
  { value: "handel-de", label: "Handel" },
  { value: "freiberuf-de", label: "Freiberuflich und Agentur" },
];

export function SetupForm() {
  const [state, action, pending] = useActionState<SetupState, FormData>(setupAction, {});

  return (
    <form action={action}>
      <div className="pad" style={{ paddingTop: 0 }}>
        {state.error ? <p className="err">{state.error}</p> : null}

        <div className="field">
          <label htmlFor="name">Firmenname</label>
          <input id="name" name="name" type="text" required autoFocus placeholder="Şahin Döner GmbH" />
          <p className="hint">
            Rechtsform und Umlaute werden für die Adresse automatisch aufgelöst.
          </p>
        </div>

        <div className="field">
          <label htmlFor="email">E-Mail-Adresse</label>
          <input id="email" name="email" type="email" autoComplete="username" required />
        </div>

        <div className="field">
          <label htmlFor="password">Passwort</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
          />
          <p className="hint">
            Mindestens 12 Zeichen. Länge schützt besser als Sonderzeichen.
          </p>
        </div>

        <div className="field">
          <label htmlFor="taxId">USt-IdNr. oder Steuernummer</label>
          <input id="taxId" name="taxId" type="text" placeholder="DE123456789" />
        </div>

        <div className="field">
          <label htmlFor="industry">Branche</label>
          <select id="industry" name="industry" defaultValue="">
            {SECTORS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <p className="hint">
            Wählt das Regelwerk, nach dem eingehende Rechnungen inhaltlich
            geprüft werden.
          </p>
        </div>

        <div className="field">
          <label htmlFor="locale">Sprache der Erklärungen</label>
          <select id="locale" name="locale" defaultValue="de">
            <option value="de">Deutsch</option>
            <option value="tr">Türkçe</option>
          </select>
        </div>

        <button className="btn solid" type="submit" disabled={pending}>
          {pending ? "Wird eingerichtet …" : "Einrichten"}
        </button>
      </div>
    </form>
  );
}
