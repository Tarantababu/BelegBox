import Link from "next/link";

export function Chrome({
  tenantName,
  current,
}: {
  tenantName: string;
  current: "inbox" | "archive";
}) {
  return (
    <header className="top">
      <div className="hrow">
        <span className="mark">
          <i />
          Belegbox
        </span>
        <span className="who">{tenantName}</span>
      </div>
      <nav className="tabs">
        <Link href="/inbox" aria-current={current === "inbox" ? "page" : undefined}>
          Eingang
        </Link>
        <Link href="/inbox?status=clean" aria-current={current === "archive" ? "page" : undefined}>
          Geprüft
        </Link>
      </nav>
    </header>
  );
}
