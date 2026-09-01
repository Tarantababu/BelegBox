"use client";

import { useActionState } from "react";
import { confirmResetAction, type ConfirmState } from "./actions";

export function ConfirmForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<ConfirmState, FormData>(
    confirmResetAction,
    {},
  );

  return (
    <form action={action}>
      <input type="hidden" name="token" value={token} />
      <div className="pad" style={{ paddingTop: 0 }}>
        {state.error ? <p className="err">{state.error}</p> : null}

        <div className="field">
          <label htmlFor="password">Neues Passwort</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
            autoFocus
          />
          <p className="hint">Mindestens 12 Zeichen. Länge schützt besser als Sonderzeichen.</p>
        </div>

        <div className="field">
          <label htmlFor="repeat">Noch einmal</label>
          <input
            id="repeat"
            name="repeat"
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
          />
        </div>

        {/* A reset must not be a way around the second factor: control of an
            inbox alone is not enough to take an account. */}
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
          {pending ? "Wird gespeichert …" : "Passwort setzen"}
        </button>
      </div>
    </form>
  );
}
