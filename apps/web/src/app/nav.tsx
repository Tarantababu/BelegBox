import Link from "next/link";
import type { Translate } from "../lib/i18n";
import { logoutAction } from "./logout";

export function Chrome({
  tenantName,
  current,
  t,
}: {
  tenantName: string;
  current: "inbox" | "archive" | "exports" | "doku" | "archiv" | "einstellungen";
  t: Translate;
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
            {t("nav.signOut")}
          </button>
        </form>
      </div>
      <nav className="tabs">
        <Link href="/inbox" aria-current={current === "inbox" ? "page" : undefined}>
          {t("nav.inbox")}
        </Link>
        <Link href="/inbox?status=clean" aria-current={current === "archive" ? "page" : undefined}>
          {t("nav.checked")}
        </Link>
        <Link href="/archiv" aria-current={current === "archiv" ? "page" : undefined}>
          {t("nav.archive")}
        </Link>
        <Link href="/exports" aria-current={current === "exports" ? "page" : undefined}>
          {t("nav.datev")}
        </Link>
        <Link href="/verfahrensdokumentation" aria-current={current === "doku" ? "page" : undefined}>
          {t("nav.doku")}
        </Link>
        <Link href="/einstellungen" aria-current={current === "einstellungen" ? "page" : undefined}>
          {t("nav.account")}
        </Link>
      </nav>
    </header>
  );
}
