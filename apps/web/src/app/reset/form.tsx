"use client";

import { useActionState } from "react";
import { translator, type Dict } from "../../lib/i18n";
import { requestResetAction, type RequestState } from "./actions";

export function RequestForm({ dict }: { dict: Dict }) {
  const t = translator(dict);
  const [state, action, pending] = useActionState<RequestState, FormData>(
    requestResetAction,
    {},
  );

  if (state.done) {
    return (
      <>
        <div className="sec">
          <div className="warnbox">{t("reset.sent")}</div>
        </div>
        {state.link ? (
          <div className="sec">
            <p className="lbl">{t("reset.devLink")}</p>
            <pre className="code">{state.link}</pre>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <form action={action}>
      <div className="pad" style={{ paddingTop: 0 }}>
        {state.errorKey ? <p className="err">{t(state.errorKey)}</p> : null}
        <div className="field">
          <label htmlFor="email">{t("common.email")}</label>
          <input id="email" name="email" type="email" autoComplete="username" required autoFocus />
        </div>
        <button className="btn solid" type="submit" disabled={pending}>
          {pending ? t("reset.requesting") : t("reset.request")}
        </button>
      </div>
    </form>
  );
}
