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
  // Through a SECURITY DEFINER function, because this is the one write that
  // cannot happen inside a tenant scope - it is the write that creates the
  // scope. The application role has SELECT on `tenants` and nothing more, so
  // inserting directly answered `permission denied for table tenants` the first
  // time a real signup ran against it. See migration 0011.
  //
  // The function body is one transaction, so the tenant and its inbox arrive
  // together or not at all: a tenant without an inbox has no address to give
  // suppliers, and setup would report success on a half-built account.
  const { rows } = await client.query<{
    tenant_id: string;
    inbox_id: string;
    name: string;
    slug: string;
    vat_id: string | null;
    tax_number: string | null;
    country: string;
    industry: string | null;
    locale: string;
    retention_policy: { invoices_years: number; vouchers_years: number };
    created_at: Date;
  }>(
    `SELECT * FROM provision_tenant($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.name,
      input.slug,
      input.inboxAddress,
      input.inboxSuffix,
      input.vatId ?? null,
      input.taxNumber ?? null,
      input.industry ?? null,
      input.locale ?? "de",
    ],
  );

  const row = rows[0];
  if (!row) throw new Error("Tenant provisioning returned no row.");

  return {
    tenant: {
      id: row.tenant_id,
      name: row.name,
      slug: row.slug,
      vat_id: row.vat_id,
      tax_number: row.tax_number,
      country: row.country,
      industry: row.industry,
      locale: row.locale,
      retention_policy: row.retention_policy,
      created_at: row.created_at,
    },
    inboxId: row.inbox_id,
    inboxAddress: input.inboxAddress,
  };
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
