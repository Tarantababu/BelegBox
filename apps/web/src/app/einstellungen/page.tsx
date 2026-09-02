import { redirect } from "next/navigation";
import { getMfaStatus, getTenant, listApiKeys } from "../../lib/api";
import { languageFor } from "../../lib/i18n";
import { resolveUi } from "../../lib/i18n/server";
import { Chrome } from "../nav";
import { revokeKeyAction } from "./actions";
import { KeyForm } from "./key-form";
import { LanguageForm } from "./language-form";
import { MfaForm } from "./mfa-form";

export const dynamic = "force-dynamic";

function shortDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${day}.${month}.${date.getUTCFullYear()}`;
}

export default async function SettingsPage() {
  const tenant = await getTenant();
  if (!tenant) redirect("/login");
  const { t, dict, lang } = await resolveUi();

  const [mfa, keys] = await Promise.all([getMfaStatus(), listApiKeys()]);
  // listApiKeys answers 403 for anyone but the owner, and returns null here.
  const isOwner = keys !== null;
  const language = languageFor(lang);

  return (
    <div className="shell">
      <Chrome tenantName={tenant.name} current="einstellungen" t={t} />

      <div className="pad">
        <h1>{t("nav.account")}</h1>
        <p className="sub">{t("acct.sub")}</p>
      </div>

      {/* Whether explanations exist in this language is a fact about the
          language, so it comes from the registry rather than from a list
          repeated here. */}
      <LanguageForm dict={dict} current={lang} hasExplanations={language.hasExplanations} />

      <MfaForm recoveryCodesLeft={mfa?.recoveryCodesLeft ?? 0} dict={dict} />

      {isOwner ? (
        <>
          <div className="sec">
            <h2>{t("acct.keysTitle")}</h2>
            <p className="sub">{t("acct.keysSub")}</p>
          </div>

          {keys.length === 0 ? (
            <div className="sec">
              <p className="note">{t("acct.keysNone")}</p>
            </div>
          ) : (
            <table className="vers">
              <thead>
                <tr>
                  <th>{t("acct.colName")}</th>
                  <th>{t("acct.colEnv")}</th>
                  <th>{t("acct.colPrefix")}</th>
                  <th>{t("acct.colLastUsed")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr key={key.id}>
                    <td>{key.name}</td>
                    <td>{key.environment}</td>
                    <td className="mono">{key.prefix}…</td>
                    <td>{shortDate(key.lastUsedAt)}</td>
                    <td>
                      {key.revokedAt ? (
                        <span className="tag">
                          {t("acct.revoked", { date: shortDate(key.revokedAt) })}
                        </span>
                      ) : (
                        <form action={revokeKeyAction}>
                          <input type="hidden" name="id" value={key.id} />
                          <button className="btn" type="submit">
                            {t("acct.revoke")}
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <KeyForm dict={dict} />
        </>
      ) : (
        <div className="sec">
          <p className="note">{t("acct.ownerOnly")}</p>
        </div>
      )}
    </div>
  );
}
