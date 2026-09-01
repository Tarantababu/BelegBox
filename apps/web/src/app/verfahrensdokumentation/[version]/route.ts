import { NextResponse } from "next/server";
import { fetchVerfahrensdokuHtml } from "../../../lib/api";

/**
 * Serves one stored fassung.
 *
 * The bytes come back exactly as they were stored - not re-rendered from the
 * facts. A fassung's hash covers what was handed over, and regenerating it here
 * would quietly produce a different document under the same version number.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ version: string }> },
): Promise<Response> {
  const { version } = await context.params;
  const parsed = Number(version);

  if (!Number.isInteger(parsed) || parsed < 1) {
    return new NextResponse("Ungültige Fassung.", { status: 400 });
  }

  const html = await fetchVerfahrensdokuHtml(parsed);
  if (html === null) {
    return new NextResponse("Diese Fassung gibt es nicht.", { status: 404 });
  }

  return new NextResponse(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
