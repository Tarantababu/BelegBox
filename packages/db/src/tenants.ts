import type { PoolClient } from "pg";
import type { TenantClient } from "./client.js";

export interface CreateTenantInput {
  name: string;
  slug: string;
  inboxAddress: string;
  inboxSuffix: string;
  vatId?: string | null;
  taxNumber?: string | null;
  industry?: string | null;
  locale?: string;
}

export interface TenantRow {
  id: string;
  name: string;
  slug: string;
  vat_id: string | null;
  tax_number: string | null;
  country: string;
  industry: string | null;
  locale: string;
  created_at: Date;
  retention_policy: { invoices_years: number; vouchers_years: number };
}

export interface CreatedTenant {
  tenant: TenantRow;
  inboxId: string;
  inboxAddress: string;
}

/**
 * Provisions a tenant and its inbox.
 *
 * Runs unscoped, because it creates the row that defines the scope - no
 * tenant-scoped policy can satisfy an insert into `tenants`. This is the one
 * operation that legitimately needs the owner connection, which is why
 * `tenants` is the one table not under FORCE.
 *
 * Both rows go in one transaction: a tenant without an inbox has no address to
 * give suppliers, and setup would report success on a half-built account.
 */
export async function createTenant(
  client: PoolClient,
  input: CreateTenantInput,
): Promise<CreatedTenant> {
  await client.query("BEGIN");
  try {
    const { rows } = await client.query<TenantRow>(
      `INSERT INTO tenants (name, slug, vat_id, tax_number, industry, locale)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, slug, vat_id, tax_number, industry, locale, created_at`,
      [
        input.name,
        input.slug,
        input.vatId ?? null,
        input.taxNumber ?? null,
        input.industry ?? null,
        input.locale ?? "de",
      ],
    );
    const tenant = rows[0];
    if (!tenant) throw new Error("Tenant insert returned no row.");

    const inbox = await client.query<{ id: string }>(
      `INSERT INTO inboxes (tenant_id, address, slug, suffix)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [tenant.id, input.inboxAddress, input.slug, input.inboxSuffix],
    );

    await client.query("COMMIT");
    return {
      tenant,
      inboxId: inbox.rows[0]?.id as string,
      inboxAddress: input.inboxAddress,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

export async function getTenant(tx: TenantClient): Promise<TenantRow | undefined> {
  const { rows } = await tx.query<TenantRow>(
    `SELECT id, name, slug, vat_id, tax_number, country, industry, locale,
            retention_policy, created_at
       FROM tenants WHERE id = $1`,
    [tx.tenantId],
  );
  return rows[0];
}

export async function getInboxAddress(tx: TenantClient): Promise<string | undefined> {
  const { rows } = await tx.query<{ address: string }>(
    "SELECT address FROM inboxes WHERE tenant_id = $1 AND active ORDER BY created_at LIMIT 1",
    [tx.tenantId],
  );
  return rows[0]?.address;
}
