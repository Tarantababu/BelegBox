import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { TENANT_COOKIE } from "../../../../lib/api";

/**
 * Development-only session switch.
 *
 * Until API keys and sessions exist, there is no way to sign in as a seeded
 * tenant. This is the stand-in, and it is exactly as dangerous as it looks: it
 * hands the caller any tenant they name. It refuses to exist in production
 * rather than relying on nobody finding it.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (process.env.NODE_ENV === "production") {
    return new NextResponse("not found", { status: 404 });
  }

  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return new NextResponse("tenant id must be a UUID", { status: 400 });
  }

  (await cookies()).set(TENANT_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24,
  });

  return NextResponse.redirect(new URL("/inbox", process.env["WEB_URL"] ?? "http://localhost:3000"));
}
