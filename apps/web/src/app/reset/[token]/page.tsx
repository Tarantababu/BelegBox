import { resolvePublicUi } from "../../../lib/i18n/server";
import { ConfirmForm } from "./form";

/**
 * The link target.
 *
 * The token stays in the URL and is never written anywhere else - no cookie, no
 * log line, no query string on a later request. `no-referrer` in the layout
 * keeps it out of the Referer header of the fonts this page loads.
 */
export default async function ResetConfirmPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const { t, dict } = await resolvePublicUi();

  return (
    <div className="shell">
      <header className="top">
        <div className="hrow">
          <span className="mark">
            <i />
            Belegbox
          </span>
        </div>
      </header>

      <div className="pad">
        <h1>{t("reset.newTitle")}</h1>
        <p className="sub">{t("reset.newSub")}</p>
      </div>

      <ConfirmForm token={token} dict={dict} />
    </div>
  );
}
