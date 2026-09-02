import { resolvePublicUi } from "../../lib/i18n/server";
import { LanguageSwitch } from "../language-switch";
import { SetupForm } from "./form";

export default async function SetupPage() {
  const { t, dict, lang } = await resolvePublicUi();

  return (
    <div className="shell">
      <header className="top">
        <div className="hrow">
          <span className="mark">
            <i />
            Belegbox
          </span>
          <LanguageSwitch current={lang} next="/setup" />
        </div>
      </header>

      <div className="pad">
        <h1>{t("setup.title")}</h1>
        <p className="sub">{t("setup.sub")}</p>
      </div>

      <SetupForm dict={dict} lang={lang} />

      <div className="sec">
        <div className="warnbox">{t("setup.warn")}</div>
      </div>
    </div>
  );
}
