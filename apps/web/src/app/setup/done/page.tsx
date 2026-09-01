import Link from "next/link";
import { redirect } from "next/navigation";
import { getTenant } from "../../../lib/api";
import { CopyBlock } from "./copy";

const API_URL = process.env["API_URL"] ?? "http://localhost:8082";

async function supplierNotice(tenantId: string): Promise<string | null> {
  // Regenerated rather than stored: the notice is derived from the address, and
  // a second copy would drift the moment the wording is improved.
  const response = await fetch(`${API_URL}/v1/tenant`, {
    headers: { "x-belegbox-tenant": tenantId },
    cache: "no-store",
  });
  if (!response.ok) return null;
  const tenant = (await response.json()) as { name: string; inboxAddress: string | null };
  if (!tenant.inboxAddress) return null;

  return [
    "Sehr geehrte Damen und Herren,",
    "",
    "wir empfangen E-Rechnungen ab sofort unter folgender Adresse:",
    "",
    `    ${tenant.inboxAddress}`,
    "",
    "Bitte senden Sie künftige Rechnungen als XRechnung (UBL oder CII) oder als",
    "ZUGFeRD/Factur-X ab Profil EN 16931 an diese Adresse. Die ZUGFeRD-Profile",
    "MINIMUM und BASIC WL enthalten keine Daten auf Positionsebene und gelten",
    "nicht als E-Rechnung.",
    "",
    "Mit freundlichen Grüßen",
    tenant.name,
  ].join("\n");
}

export default async function SetupDone() {
  const tenant = await getTenant();
  if (!tenant) redirect("/setup");

  const notice = await supplierNotice(tenant.id);

  return (
    <div className="shell">
      <header className="top">
        <div className="hrow">
          <span className="mark">
            <i />
            Belegbox
          </span>
          <span className="who">{tenant.name}</span>
        </div>
      </header>

      <div className="pad">
        <h1>Fertig.</h1>
        <p className="sub">Das ist deine Adresse für eingehende E-Rechnungen.</p>
      </div>

      <div className="sec">
        <p className="lbl">Rechnungsadresse</p>
        <pre className="code" style={{ fontSize: 15 }}>
          {tenant.inboxAddress}
        </pre>
        <p className="note" style={{ marginTop: 10 }}>
          Die zufällige Endung gehört zur Adresse. Sie sorgt dafür, dass niemand
          die Adresse aus deinem Firmennamen erraten und dir eine gefälschte
          Rechnung zustellen kann.
        </p>
      </div>

      {notice ? (
        <div className="sec">
          <p className="lbl">Text für deine Lieferanten</p>
          <CopyBlock text={notice} />
        </div>
      ) : null}

      <div className="sec">
        <Link className="btn solid" href="/inbox">
          Zum Eingang
        </Link>
      </div>
    </div>
  );
}
