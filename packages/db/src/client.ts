import pg from "pg";
import type { Pool, PoolClient, QueryResultRow } from "pg";

const { Pool: PgPool } = pg;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

/** A client already scoped to one tenant for the life of its transaction. */
export interface TenantClient extends Queryable {
  readonly tenantId: string;
}

export function createPool(connectionString: string, max = 10): Pool {
  return new PgPool({ connectionString, max });
}

export class Db {
  constructor(private readonly pool: Pool) {}

  /**
   * Runs `fn` inside a transaction scoped to one tenant.
   *
   * Two details carry the whole isolation guarantee:
   *
   * `set_config(..., true)` sets the value **transaction-locally**. A plain
   * `SET` would persist on the pooled connection, and with PgBouncer in
   * transaction mode that connection goes to the next request - which is how
   * tenant isolation silently switches itself off in production. The parameter
   * is bound, not interpolated, so a tenant id can never carry SQL.
   *
   * Row Level Security then does the enforcing. This method is the only way to
   * reach tenant data; there is no unscoped read path.
   */
  async withTenant<T>(tenantId: string, fn: (tx: TenantClient) => Promise<T>): Promise<T> {
    if (!UUID.test(tenantId)) {
      throw new Error("withTenant requires a UUID tenant id.");
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);

      const scoped: TenantClient = {
        tenantId,
        query: (text, values) => client.query(text, values as never[]),
      };

      const result = await fn(scoped);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Runs without a tenant scope.
   *
   * Reserved for migrations, tenant creation and operational tooling. Under
   * RLS this sees nothing tenant-scoped anyway unless it connects as a role
   * that owns the tables - which the application role deliberately does not.
   */
  async withAdmin<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
