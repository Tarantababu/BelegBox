"use client";

import { useActionState } from "react";
import { loginAction, type LoginState } from "./actions";

export function LoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, {});

  return (
    <form action={action}>
      <div className="pad" style={{ paddingTop: 0 }}>
        {state.error ? <p className="err">{state.error}</p> : null}

        <div className="field">
          <label htmlFor="email">E-Mail-Adresse</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            autoFocus
          />
        </div>

        <div className="field">
          <label htmlFor="password">Passwort</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </div>

        {/* Shown only once the password was accepted, so the form never reveals
            whether an address exists. */}
        {state.mfaRequired ? (
          <div className="field">
            <label htmlFor="totpCode">Code aus deiner Authenticator-App</label>
            <input
              id="totpCode"
              name="totpCode"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              autoFocus
            />
            <p className="hint">Sechs Ziffern, wechselt alle 30 Sekunden.</p>
          </div>
        ) : null}

        <button className="btn solid" type="submit" disabled={pending}>
          {pending ? "Anmelden …" : "Anmelden"}
        </button>
      </div>
    </form>
  );
}
