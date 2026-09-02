"use client";

import { useActionState } from "react";
import { translator, type Dict } from "../../../lib/i18n";
import { confirmResetAction, type ConfirmState } from "./actions";

export function ConfirmForm({ token, dict }: { token: string; dict: Dict }) {
  const t = translator(dict);
  const [state, action, pending] = useActionState<ConfirmState, FormData>(
    confirmResetAction,
    {},
  );

  return (
    <form action={action}>
      <input type="hidden" name="token" value={token} />
      <div className="pad" style={{ paddingTop: 0 }}>
        {state.errorKey ? <p className="err">{t(state.errorKey)}</p> : null}

        <div className="field">
          <label htmlFor="password">{t("reset.newPassword")}</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
            autoFocus
          />
          <p className="hint">{t("common.passwordHint")}</p>
        </div>

        <div className="field">
          <label htmlFor="repeat">{t("reset.repeat")}</label>
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
          {pending ? t("reset.saving") : t("reset.save")}
        </button>
      </div>
    </form>
  );
}
