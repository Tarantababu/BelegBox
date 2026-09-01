import Link from "next/link";
import { logoutAction } from "./logout";

export function Chrome({
  tenantName,
  current,
}: {
  tenantName: string;
  current: "inbox" | "archive" | "exports" | "doku" | "archiv";
}) {
  return (
    <header className="top">
      <div className="hrow">
        <span className="mark">
          <i />
          Belegbox
        </span>
        <span className="who">{tenantName}</span>
        <form action={logoutAction}>
          <button className="btn" type="submit" style={{ padding: "5px 10px", fontSize: 13 }}>
            Abmelden
          </button>
        </form>
      </div>
      <nav className="tabs">
        <Link href="/inbox" aria-current={current === "inbox" ? "page" : undefined}>
          Eingang
        </Link>
        <Link href="/inbox?status=clean" aria-current={current === "archive" ? "page" : undefined}>
          Geprüft
        </Link>
        <Link href="/archiv" aria-current={current === "archiv" ? "page" : undefined}>
          Archiv
        </Link>
        <Link href="/exports" aria-current={current === "exports" ? "page" : undefined}>
          DATEV-Export
        </Link>
        <Link href="/verfahrensdokumentation" aria-current={current === "doku" ? "page" : undefined}>
          Verfahrensdokumentation
        </Link>
      </nav>
    </header>
  );
}
