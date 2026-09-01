"use client";

import { useActionState } from "react";
import { createKeyAction, type KeyState } from "./actions";

export function KeyForm() {
  const [state, action, pending] = useActionState<KeyState, FormData>(createKeyAction, {});

  if (state.token) {
    return (
      <div className="sec">
        <h3>Schlüssel „{state.name}“</h3>
        <p className="note">
          Dieser Schlüssel wird nur jetzt angezeigt. Gespeichert ist nur seine
          Prüfsumme — es gibt keinen Weg, ihn später noch einmal zu sehen. Geht
          er verloren, wird er ersetzt, nicht wiederhergestellt.
        </p>
        <p className="code">{state.token}</p>
      </div>
    );
  }

  return (
    <form action={action}>
      <div className="sec">
        <h3>Neuen Schlüssel anlegen</h3>
        {state.error ? <p className="err">{state.error}</p> : null}
        <div className="field">
          <label htmlFor="key-name">Name</label>
          <input id="key-name" name="name" required placeholder="z. B. Kassensystem" />
          <p className="hint">Wofür der Schlüssel benutzt wird — sichtbar in der Liste.</p>
        </div>
        <div className="field">
          <label htmlFor="key-env">Umgebung</label>
          <select id="key-env" name="environment" defaultValue="live">
            <option value="live">live</option>
            <option value="test">test</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="key-password">Aktuelles Passwort</label>
          <input
            id="key-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </div>
        <button className="btn solid" type="submit" disabled={pending}>
          {pending ? "Wird angelegt…" : "Schlüssel anlegen"}
        </button>
      </div>
    </form>
  );
}
