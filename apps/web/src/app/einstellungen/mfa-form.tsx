"use client";

import { useActionState } from "react";
import { beginMfaAction, confirmMfaAction, type MfaState } from "./actions";

/**
 * Rotating the second factor, in the order that keeps someone from locking
 * themselves out: prove who you are, scan the new secret, prove the scan
 * worked, and only then is the old authenticator retired.
 */
export function MfaForm({ recoveryCodesLeft }: { recoveryCodesLeft: number }) {
  const [begun, beginAction, beginning] = useActionState<MfaState, FormData>(
    beginMfaAction,
    {},
  );
  const [confirmed, confirmAction, confirming] = useActionState<MfaState, FormData>(
    confirmMfaAction,
    begun,
  );

  const state = confirmed.recoveryCodes || confirmed.error ? confirmed : begun;

  if (state.recoveryCodes) {
    return (
      <div className="sec">
        <h3>Wiederherstellungscodes</h3>
        <p className="note">
          Jeder Code funktioniert einmal, anstelle des Codes aus der App. Sie
          werden nur jetzt angezeigt — bitte ausdrucken oder in den
          Passwortmanager legen. Alle anderen Sitzungen wurden beendet.
        </p>
        <ul className="codes">
          {state.recoveryCodes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
      </div>
    );
  }

  if (state.secret) {
    return (
      <form action={confirmAction}>
        <div className="sec">
          <h3>Neuen Code scannen</h3>
          <p className="note">
            In der Authenticator-App hinzufügen, dann den angezeigten Code
            eingeben. Der bisherige zweite Faktor gilt so lange weiter, bis der
            neue bestätigt ist.
          </p>
          <p className="code">{state.secret}</p>
          {state.uri ? (
            <p className="hint">
              Oder diesen Link in der App öffnen: <code>{state.uri}</code>
            </p>
          ) : null}
          {state.error ? <p className="err">{state.error}</p> : null}
          <div className="field">
            <label htmlFor="code">Code aus der App</label>
            <input
              id="code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              autoFocus
            />
          </div>
          <button className="btn solid" type="submit" disabled={confirming}>
            {confirming ? "Wird geprüft…" : "Bestätigen"}
          </button>
        </div>
      </form>
    );
  }

  return (
    <form action={beginAction}>
      <div className="sec">
        <h3>Zwei-Faktor-Anmeldung</h3>
        <p className="note">
          {recoveryCodesLeft > 0
            ? `${recoveryCodesLeft} Wiederherstellungscodes sind noch nicht verbraucht.`
            : "Es sind keine Wiederherstellungscodes hinterlegt. Beim Neueinrichten werden zehn erzeugt."}
        </p>
        {state.error ? <p className="err">{state.error}</p> : null}
        <div className="field">
          <label htmlFor="mfa-password">Aktuelles Passwort</label>
          <input
            id="mfa-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
          <p className="hint">
            Wird erneut abgefragt, weil hier die Anmeldedaten selbst geändert
            werden. Eine übernommene Sitzung allein soll dafür nicht reichen.
          </p>
        </div>
        <button className="btn" type="submit" disabled={beginning}>
          {beginning ? "Wird vorbereitet…" : "Neu einrichten"}
        </button>
      </div>
    </form>
  );
}
