import { NextResponse } from "next/server";
import { exportBelege } from "../../../lib/api";
import { resolveUi } from "../../../lib/i18n/server";

/**
 * Streams the bundle of originals to the browser.
 *
 * The counts come back on headers rather than in the body, because the body is
 * the ZIP. They are passed through so a caller watching the network - or a
 * future page that wants to report the outcome - sees the same numbers the
 * manifest inside the file carries.
 */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";

  if (!from || !to) {
    const { t } = await resolveUi();
    return new NextResponse(t("err.periodRequired"), { status: 400 });
  }

  const result = await exportBelege({ from, to });
  if (!result.ok) {
    return new NextResponse(result.error, { status: 400 });
  }

  return new NextResponse(result.bundle.bytes, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${result.bundle.filename}"`,
      "cache-control": "no-store",
      "x-belegbox-included": String(result.bundle.included),
      "x-belegbox-skipped": String(result.bundle.skipped),
      "x-belegbox-integrity-failures": String(result.bundle.integrityFailures),
    },
  });
}
