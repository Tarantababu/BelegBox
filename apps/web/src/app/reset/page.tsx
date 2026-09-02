import Link from "next/link";
import { resolvePublicUi } from "../../lib/i18n/server";
import { LanguageSwitch } from "../language-switch";
import { RequestForm } from "./form";

export default async function ResetRequestPage() {
  const { t, dict, lang } = await resolvePublicUi();

  return (
    <div className="shell">
      <header className="top">
        <div className="hrow">
          <span className="mark">
            <i />
            Belegbox
          </span>
          <LanguageSwitch current={lang} next="/reset" />
        </div>
      </header>

      <div className="pad">
        <h1>{t("reset.title")}</h1>
        <p className="sub">{t("reset.sub")}</p>
      </div>

      <RequestForm dict={dict} />

      <div className="sec">
        <p className="note">
          <Link href="/login" style={{ textDecoration: "underline" }}>
            {t("reset.backToLogin")}
          </Link>
        </p>
      </div>
    </div>
  );
}
