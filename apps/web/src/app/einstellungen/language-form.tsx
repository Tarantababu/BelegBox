"use client";

import { useActionState } from "react";
import { LANGUAGES, translator, type Dict } from "../../lib/i18n";
import { changeLanguageAction, type LanguageState } from "./actions";

/**
 * The language picker.
 *
 * Two things it says out loud that a picker normally would not:
 *
 *   - Whose setting this is. It is the person's, not the business's, and two
 *     people sharing a Betrieb should not surprise each other.
 *   - Which languages the *explanations* come in. Eight of these ten have no
 *     reviewed legal wording behind them, so a finding explains itself in
 *     German however the buttons read. Saying so next to the choice is the
 *     honest place for it; discovering it on a document detail screen is not.
 */
export function LanguageForm({
  dict,
  current,
  hasExplanations,
}: {
  dict: Dict;
  current: string;
  /** Whether reviewed explanation wording exists in the saved language. */
  hasExplanations: boolean;
}) {
  const t = translator(dict);
  const [state, action, pending] = useActionState<LanguageState, FormData>(
    changeLanguageAction,
    {},
  );

  return (
    <form action={action}>
      <div className="sec">
        <h3>{t("acct.langTitle")}</h3>
        <p className="note">{t("acct.langSub")}</p>

        {state.errorKey ? <p className="err">{t(state.errorKey)}</p> : null}
        {state.error ? <p className="err">{state.error}</p> : null}
        {state.saved ? <p className="ok">{t("acct.langSaved")}</p> : null}

        <div className="field" style={{ marginTop: 12 }}>
          <label htmlFor="language">{t("acct.langLabel")}</label>
          {/* Each language named in itself. A list that says "Arabisch" is
              unreadable to exactly the person looking for Arabic. */}
          {/* `key` on an uncontrolled select is what makes it agree with the
              database after a save. `defaultValue` is read once at mount, so
              without this the whole page came back in the new language while
              the picker still displayed the old one - a control contradicting
              the screen it sits on. Keying it to the saved value remounts it
              when, and only when, the saved value actually changed. */}
          <select
            key={current}
            id="language"
            name="language"
            defaultValue={current}
          >
            {LANGUAGES.map((language) => (
              <option key={language.code} value={language.code}>
                {language.endonym}
              </option>
            ))}
          </select>
        </div>

        <button className="btn" type="submit" disabled={pending}>
          {pending ? t("acct.langSaving") : t("acct.langSave")}
        </button>

        {/* One line or the other, never both. Stacked, "explanations exist
            only in German and Turkish" directly above "explanations exist in
            this language" reads as a contradiction even though both are true.
            The caveat is what someone about to switch away needs; the
            confirmation is what someone already on German or Turkish needs. */}
        <p className="note" style={{ marginTop: 12 }}>
          {hasExplanations ? t("acct.langExplainOk") : t("acct.langExplainNote")}
        </p>
      </div>
    </form>
  );
}
