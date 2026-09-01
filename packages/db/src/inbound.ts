import type { PoolClient } from "pg";
import type { TenantClient } from "./client.js";

export interface ResolvedInbox {
  inboxId: string;
  tenantId: string;
}

/**
 * Maps an inbox address to its tenant.
 *
 * Runs before a tenant scope exists, because it is the step that establishes
 * one, so it goes through a SECURITY DEFINER function rather than RLS. An
 * unknown address returns nothing - the caller must treat that as unroutable
 * rather than guessing.
 */
export async function resolveInbox(
  client: PoolClient,
  address: string,
): Promise<ResolvedInbox | undefined> {
  const { rows } = await client.query<{ inbox_id: string; tenant_id: string }>(
    "SELECT inbox_id, tenant_id FROM resolve_inbox($1)",
    [address],
  );
  const row = rows[0];
  return row ? { inboxId: row.inbox_id, tenantId: row.tenant_id } : undefined;
}

export interface ClaimInput {
  provider: string;
  providerMessageId: string;
  tenantId: string | null;
  recipient: string;
  messageId?: string | null;
}

/**
 * Claims a message for processing, atomically.
 *
 * Returns the row id when this call won the claim, or undefined when another
 * delivery of the same message already has it. Runs inside the caller's
 * transaction: a rollback releases the claim, so a processing failure does not
 * permanently swallow a redelivery.
 */
export async function claimInboundMessage(
  tx: TenantClient | { query: TenantClient["query"] },
  input: ClaimInput,
): Promise<string | undefined> {
  const { rows } = await tx.query<{ claim_inbound_message: string | null }>(
    "SELECT claim_inbound_message($1, $2, $3, $4, $5)",
    [
      input.provider,
      input.providerMessageId,
      input.tenantId,
      input.recipient,
      input.messageId ?? null,
    ],
  );
  const id = rows[0]?.claim_inbound_message;
  return id === null || id === undefined ? undefined : String(id);
}

export async function finishInboundMessage(
  tx: TenantClient | { query: TenantClient["query"] },
  claimId: string,
  documentCount: number,
  warnings: string[],
): Promise<void> {
  await tx.query("SELECT finish_inbound_message($1, $2, $3)", [
    claimId,
    documentCount,
    warnings,
  ]);
}
