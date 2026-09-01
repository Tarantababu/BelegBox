import type { Db } from "./client.js";

export class RlsBypassError extends Error {
  constructor(readonly role: string, readonly reasons: string[]) {
    super(
      `Refusing to start: the database role "${role}" can bypass Row Level Security (${reasons.join(", ")}). ` +
        "Tenant isolation would not be enforced and every tenant would see every document. " +
        "Connect as a non-superuser role without BYPASSRLS - belegbox_app exists for this.",
    );
    this.name = "RlsBypassError";
  }
}

/**
 * Refuses to run against a connection that can step around RLS.
 *
 * There was already a test asserting that `belegbox_app` is not a superuser and
 * holds no BYPASSRLS. It passed, and the application was still pointed at the
 * `postgres` superuser in development - so every tenant saw every other
 * tenant's documents, and the screen looked entirely convincing while doing it.
 *
 * The test checked the role. Nothing checked the connection. A property that
 * matters this much has to be verified by the process that depends on it, at
 * the moment it starts, rather than asserted somewhere else and assumed.
 */
export async function assertRlsEnforced(db: Db): Promise<void> {
  const row = await db.withAdmin(async (client) => {
    const result = await client.query<{
      role: string;
      is_superuser: boolean;
      bypassrls: boolean;
    }>(
      `SELECT current_user AS role,
              current_setting('is_superuser') = 'on' AS is_superuser,
              (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypassrls`,
    );
    return result.rows[0];
  });

  if (!row) throw new Error("Could not determine the current database role.");

  const reasons: string[] = [];
  if (row.is_superuser) reasons.push("superuser");
  if (row.bypassrls) reasons.push("BYPASSRLS");

  if (reasons.length > 0) throw new RlsBypassError(row.role, reasons);
}
