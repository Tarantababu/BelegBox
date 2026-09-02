"use client";

import { useActionState } from "react";
import { translator, type Dict } from "../../lib/i18n";
import { createKeyAction, type KeyState } from "./actions";

export function KeyForm({ dict }: { dict: Dict }) {
  const t = translator(dict);
  const [state, action, pending] = useActionState<KeyState, FormData>(createKeyAction, {});
  const error = state.errorKey ? t(state.errorKey) : state.error;

  if (state.token) {
    return (
      <div className="sec">
        <h3>{t("acct.keyShown", { name: state.name ?? "" })}</h3>
        <p className="note">{t("acct.keyOnce")}</p>
        <p className="code">{state.token}</p>
      </div>
    );
  }

  return (
    <form action={action}>
      <div className="sec">
        <h3>{t("acct.newKeyTitle")}</h3>
        {error ? <p className="err">{error}</p> : null}
        <div className="field">
          <label htmlFor="key-name">{t("acct.colName")}</label>
          <input id="key-name" name="name" required placeholder={t("acct.keyNamePlaceholder")} />
          <p className="hint">{t("acct.keyNameHint")}</p>
        </div>
        <div className="field">
          <label htmlFor="key-env">{t("acct.colEnv")}</label>
          <select id="key-env" name="environment" defaultValue="live">
            <option value="live">live</option>
            <option value="test">test</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="key-password">{t("common.currentPassword")}</label>
          <input
            id="key-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </div>
        <button className="btn solid" type="submit" disabled={pending}>
          {pending ? t("acct.creatingKey") : t("acct.createKey")}
        </button>
      </div>
    </form>
  );
}
