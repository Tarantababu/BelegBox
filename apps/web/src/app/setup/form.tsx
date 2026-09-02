"use client";

import { useActionState } from "react";
import { LANGUAGES, translator, type Dict } from "../../lib/i18n";
import { setupAction, type SetupState } from "./actions";

const SECTORS = [
  { value: "", key: "setup.chooseSector" },
  { value: "gastro-de", key: "setup.sector.gastro" },
  { value: "handwerk-bau-de", key: "setup.sector.handwerk" },
  { value: "logistik-de", key: "setup.sector.logistik" },
  { value: "handel-de", key: "setup.sector.handel" },
  { value: "freiberuf-de", key: "setup.sector.frei" },
] as const;

export function SetupForm({ dict, lang }: { dict: Dict; lang: string }) {
  const t = translator(dict);
  const [state, action, pending] = useActionState<SetupState, FormData>(setupAction, {});

  return (
    <form action={action}>
      <div className="pad" style={{ paddingTop: 0 }}>
        {state.errorKey ? <p className="err">{t(state.errorKey)}</p> : null}
        {state.error ? <p className="err">{state.error}</p> : null}

        <div className="field">
          <label htmlFor="name">{t("setup.name")}</label>
          <input id="name" name="name" type="text" required autoFocus placeholder="Şahin Döner GmbH" />
          <p className="hint">{t("setup.nameHint")}</p>
        </div>

        <div className="field">
          <label htmlFor="email">{t("common.email")}</label>
          <input id="email" name="email" type="email" autoComplete="username" required />
        </div>

        <div className="field">
          <label htmlFor="password">{t("common.password")}</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
          />
          <p className="hint">{t("common.passwordHint")}</p>
        </div>

        <div className="field">
          <label htmlFor="taxId">{t("setup.taxId")}</label>
          <input id="taxId" name="taxId" type="text" placeholder="DE123456789" />
        </div>

        <div className="field">
          <label htmlFor="industry">{t("setup.industry")}</label>
          <select id="industry" name="industry" defaultValue="">
            {SECTORS.map((sector) => (
              <option key={sector.value} value={sector.value}>
                {t(sector.key)}
              </option>
            ))}
          </select>
          <p className="hint">{t("setup.industryHint")}</p>
        </div>

        {/* Defaults to whatever the reader is already looking at, which is
            either their own pick from the header switch or what their browser
            asked for. The field used to offer two languages and default to
            German regardless. */}
        <div className="field">
          <label htmlFor="locale">{t("setup.language")}</label>
          <select id="locale" name="locale" defaultValue={lang}>
            {LANGUAGES.map((language) => (
              <option key={language.code} value={language.code}>
                {language.endonym}
              </option>
            ))}
          </select>
        </div>

        <button className="btn solid" type="submit" disabled={pending}>
          {pending ? t("setup.submitting") : t("setup.submit")}
        </button>
      </div>
    </form>
  );
}
