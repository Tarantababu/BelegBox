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
        <h1>Neues Passwort</h1>
        <p className="sub">
          Danach wirst du auf allen Geräten abgemeldet — auch dort, wo du es
          vielleicht nicht selbst warst.
        </p>
      </div>

      <ConfirmForm token={token} />
    </div>
  );
}
