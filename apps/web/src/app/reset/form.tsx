"use client";

import { useActionState } from "react";
import { requestResetAction, type RequestState } from "./actions";

export function RequestForm() {
  const [state, action, pending] = useActionState<RequestState, FormData>(
    requestResetAction,
    {},
  );

  if (state.done) {
    return (
      <>
        <div className="sec">
          <div className="warnbox">
            Wenn es zu dieser Adresse ein Konto gibt, ist eine E-Mail unterwegs.
            Der Link gilt eine Stunde und funktioniert nur einmal.
          </div>
        </div>
        {state.link ? (
          <div className="sec">
            <p className="lbl">Entwicklungsmodus — der Link wird sonst per E-Mail zugestellt</p>
            <pre className="code">{state.link}</pre>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <form action={action}>
      <div className="pad" style={{ paddingTop: 0 }}>
        {state.error ? <p className="err">{state.error}</p> : null}
        <div className="field">
          <label htmlFor="email">E-Mail-Adresse</label>
          <input id="email" name="email" type="email" autoComplete="username" required autoFocus />
        </div>
        <button className="btn solid" type="submit" disabled={pending}>
          {pending ? "Wird gesendet …" : "Link anfordern"}
        </button>
      </div>
    </form>
  );
}
