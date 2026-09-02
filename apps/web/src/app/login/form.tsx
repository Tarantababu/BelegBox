"use client";

import { useActionState } from "react";
import { translator, type Dict } from "../../lib/i18n";
import { loginAction, type LoginState } from "./actions";

/**
 * The dictionary arrives as a prop rather than being looked up here.
 *
 * A client component importing the registry would pull all ten languages into
 * the browser bundle to render one. The server already resolved which one this
 * reader gets; passing that single object is a few kilobytes of RSC payload
 * instead.
 */
export function LoginForm({ dict }: { dict: Dict }) {
  const t = translator(dict);
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, {});

  return (
    <form action={action}>
      <div className="pad" style={{ paddingTop: 0 }}>
        {state.errorKey ? <p className="err">{t(state.errorKey)}</p> : null}

        <div className="field">
          <label htmlFor="email">{t("common.email")}</label>
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
          <label htmlFor="password">{t("common.password")}</label>
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
            <label htmlFor="totpCode">{t("common.totpLabel")}</label>
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
            <p className="hint">{t("common.totpHint")}</p>
          </div>
        ) : null}

        <button className="btn solid" type="submit" disabled={pending}>
          {pending ? t("login.submitting") : t("login.submit")}
        </button>
      </div>
    </form>
  );
}
