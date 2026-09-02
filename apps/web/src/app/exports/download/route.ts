import { NextResponse } from "next/server";
import { exportDatev } from "../../../lib/api";
import { resolveUi } from "../../../lib/i18n/server";

/**
 * Streams the Buchungsstapel to the browser as a download.
 *
 * The API returns base64 because the file is Windows-1252 and JSON is UTF-8;
 * decoding here and setting the bytes directly is what keeps the umlauts as
 * single bytes all the way into DATEV.
 */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;

  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const beraterNumber = Number(params.get("berater"));
  const mandantNumber = Number(params.get("mandant"));

  if (!from || !to || !Number.isInteger(beraterNumber) || !Number.isInteger(mandantNumber)) {
    const { t } = await resolveUi();
    return new NextResponse(t("err.datevRequired"), { status: 400 });
  }

  const result = await exportDatev({
    from,
    to,
    beraterNumber,
    mandantNumber,
    ...(params.get("chart") ? { chart: params.get("chart") as string } : {}),
  });

  if (!result.ok) {
    return new NextResponse(result.error, { status: 400 });
  }

  return new NextResponse(Buffer.from(result.export.contentBase64, "base64"), {
    headers: {
      // The charset is part of the contract: DATEV reads ANSI, not UTF-8.
      "content-type": "text/csv; charset=windows-1252",
      "content-disposition": `attachment; filename="${result.export.filename}"`,
      "cache-control": "no-store",
    },
  });
}
