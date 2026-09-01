import { NextResponse } from "next/server";
import { generateVerfahrensdoku } from "../../../lib/api";

/**
 * Generating a fassung is an event, so it is a POST and it redirects.
 *
 * A reload of the resulting page must not produce another fassung - the history
 * is evidence, and filling it with duplicates from a stray refresh devalues it.
 */
export async function POST(request: Request): Promise<Response> {
  const result = await generateVerfahrensdoku();
  const base = new URL("/verfahrensdokumentation", request.url);

  if (!result.ok) {
    base.searchParams.set("fehler", result.error);
    return NextResponse.redirect(base, { status: 303 });
  }

  base.searchParams.set("fassung", String(result.version));
  return NextResponse.redirect(base, { status: 303 });
}
