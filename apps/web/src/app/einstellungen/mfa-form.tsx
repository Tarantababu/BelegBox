"use client";

import { useActionState } from "react";
import { translator, type Dict } from "../../lib/i18n";
import { beginMfaAction, confirmMfaAction, type MfaState } from "./actions";

/**
 * Rotating the second factor, in the order that keeps someone from locking
 * themselves out: prove who you are, scan the new secret, prove the scan
 * worked, and only then is the old authenticator retired.
 */
export function MfaForm({
  recoveryCodesLeft,
  dict,
}: {
  recoveryCodesLeft: number;
  dict: Dict;
}) {
  const t = translator(dict);
  const [begun, beginAction, beginning] = useActionState<MfaState, FormData>(
    beginMfaAction,
    {},
  );
  const [confirmed, confirmAction, confirming] = useActionState<MfaState, FormData>(
    confirmMfaAction,
    begun,
  );

  const state =
    confirmed.recoveryCodes || confirmed.error || confirmed.errorKey ? confirmed : begun;
  const error = state.errorKey ? t(state.errorKey) : state.error;

  if (state.recoveryCodes) {
    return (
      <div className="sec">
        <h3>{t("mfa.recoveryTitle")}</h3>
        <p className="note">{t("mfa.recoveryNote")}</p>
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
          <h3>{t("mfa.scanTitle")}</h3>
          <p className="note">{t("mfa.scanNote")}</p>
          <p className="code">{state.secret}</p>
          {state.uri ? (
            <p className="hint">
              {t("mfa.orLink")} <code>{state.uri}</code>
            </p>
          ) : null}
          {error ? <p className="err">{error}</p> : null}
          <div className="field">
            <label htmlFor="code">{t("mfa.codeLabel")}</label>
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
            {confirming ? t("mfa.confirming") : t("mfa.confirm")}
          </button>
        </div>
      </form>
    );
  }

  return (
    <form action={beginAction}>
      <div className="sec">
        <h3>{t("mfa.title")}</h3>
        <p className="note">
          {recoveryCodesLeft > 0
            ? t("mfa.codesLeft", { n: recoveryCodesLeft })
            : t("mfa.codesNone")}
        </p>
        {error ? <p className="err">{error}</p> : null}
        <div className="field">
          <label htmlFor="mfa-password">{t("common.currentPassword")}</label>
          <input
            id="mfa-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
          <p className="hint">{t("mfa.passwordHint")}</p>
        </div>
        <button className="btn" type="submit" disabled={beginning}>
          {beginning ? t("mfa.beginning") : t("mfa.begin")}
        </button>
      </div>
    </form>
  );
}
