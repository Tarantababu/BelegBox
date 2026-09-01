"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createTenantAccount, TENANT_COOKIE } from "../../lib/api";

export interface SetupState {
  error?: string;
}

/**
 * M-01. Three fields, no card, under 90 seconds.
 *
 * The sector is not decoration: it selects the ruleset that decides what the
 * content verdict checks. Everything else the product needs it derives - the
 * inbox address, the slug, the supplier notice.
 */
export async function setupAction(
  _previous: SetupState,
  formData: FormData,
): Promise<SetupState> {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Bitte den Firmennamen eingeben." };

  const taxId = String(formData.get("taxId") ?? "").trim();
  const industry = String(formData.get("industry") ?? "").trim();
  const locale = String(formData.get("locale") ?? "de").trim();

  let created: Awaited<ReturnType<typeof createTenantAccount>>;
  try {
    created = await createTenantAccount({
      name,
      ...(taxId ? { taxId } : {}),
      ...(industry ? { industry } : {}),
      locale,
    });
  } catch (err) {
    return { error: (err as Error).message };
  }

  // Placeholder for a session. It carries a tenant id and nothing else: anyone
  // who edits this cookie becomes another tenant. Real authentication lands
  // before this is exposed to anybody, and it is httpOnly so at least page
  // scripts cannot read it.
  (await cookies()).set(TENANT_COOKIE, created.tenantId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });

  redirect("/setup/done");
}
