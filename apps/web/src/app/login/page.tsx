import Link from "next/link";
import { resolvePublicUi } from "../../lib/i18n/server";
import { LanguageSwitch } from "../language-switch";
import { LoginForm } from "./form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reset?: string }>;
}) {
  const justReset = (await searchParams).reset === "done";
  const { t, dict, lang } = await resolvePublicUi();

  return (
    <div className="shell">
      <header className="top">
        <div className="hrow">
          <span className="mark">
            <i />
            Belegbox
          </span>
          <LanguageSwitch current={lang} next="/login" />
        </div>
      </header>

      <div className="pad">
        <h1>{t("login.title")}</h1>
        <p className="sub">{t("login.sub")}</p>
      </div>

      {justReset ? (
        <div className="sec">
          <div className="warnbox">{t("login.passwordChanged")}</div>
        </div>
      ) : null}

      <LoginForm dict={dict} />

      <div className="sec">
        <p className="note">
          <Link href="/reset" style={{ textDecoration: "underline" }}>
            {t("login.forgot")}
          </Link>
        </p>
        <p className="note" style={{ marginTop: 8 }}>
          {t("login.noAccount")}{" "}
          <Link href="/setup" style={{ textDecoration: "underline" }}>
            {t("login.startSetup")}
          </Link>
        </p>
      </div>
    </div>
  );
}
