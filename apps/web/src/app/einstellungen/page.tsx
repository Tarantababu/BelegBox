import { redirect } from "next/navigation";
import { getMfaStatus, getTenant, listApiKeys } from "../../lib/api";
import { Chrome } from "../nav";
import { revokeKeyAction } from "./actions";
import { KeyForm } from "./key-form";
import { MfaForm } from "./mfa-form";

export const dynamic = "force-dynamic";

function germanDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${day}.${month}.${date.getUTCFullYear()}`;
}

export default async function SettingsPage() {
  const tenant = await getTenant();
  if (!tenant) redirect("/login");

  const [mfa, keys] = await Promise.all([getMfaStatus(), listApiKeys()]);
  // listApiKeys answers 403 for anyone but the owner, and returns null here.
  const isOwner = keys !== null;

  return (
    <div className="shell">
      <Chrome tenantName={tenant.name} current="einstellungen" />

      <div className="pad">
        <h1>Konto</h1>
        <p className="sub">Zweiter Faktor und Zugangsschlüssel.</p>
      </div>

      <MfaForm recoveryCodesLeft={mfa?.recoveryCodesLeft ?? 0} />

      {isOwner ? (
        <>
          <div className="sec">
            <h2>API-Schlüssel</h2>
            <p className="sub">
              Für eigene Anbindungen — ein Kassensystem, das Rechnungen
              übergibt. Ein Schlüssel authentifiziert den Mandanten, nicht eine
              Person: er kann keinen zweiten Faktor ändern und keine weiteren
              Schlüssel anlegen.
            </p>
          </div>

          {keys.length === 0 ? (
            <div className="sec">
              <p className="note">Es gibt noch keine Schlüssel.</p>
            </div>
          ) : (
            <table className="vers">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Umgebung</th>
                  <th>Kennung</th>
                  <th>Zuletzt benutzt</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr key={key.id}>
                    <td>{key.name}</td>
                    <td>{key.environment}</td>
                    <td className="mono">{key.prefix}…</td>
                    <td>{germanDate(key.lastUsedAt)}</td>
                    <td>
                      {key.revokedAt ? (
                        <span className="tag">gesperrt {germanDate(key.revokedAt)}</span>
                      ) : (
                        <form action={revokeKeyAction}>
                          <input type="hidden" name="id" value={key.id} />
                          <button className="btn" type="submit">
                            Sperren
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <KeyForm />
        </>
      ) : (
        <div className="sec">
          <p className="note">
            API-Schlüssel verwaltet der Inhaber des Kontos.
          </p>
        </div>
      )}
    </div>
  );
}
