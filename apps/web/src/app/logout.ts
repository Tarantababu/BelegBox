"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { logout, SESSION_COOKIE } from "../lib/api";

/**
 * Signs out on both sides.
 *
 * The API revokes the session so the token is dead even if the cookie survives
 * somewhere; clearing the cookie alone would leave a working token in a proxy
 * log or a browser that ignored the header.
 */
export async function logoutAction(): Promise<void> {
  await logout();
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
