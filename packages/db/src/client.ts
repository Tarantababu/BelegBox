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

export interface PoolOptions {
  /** Connections this process may hold. See the note on sizing below. */
  max?: number;
  /**
   * Kills a query that has run away rather than letting it pin a connection.
   *
   * Every statement in this codebase is a keyed lookup or a bounded scan, so
   * anything near this ceiling is a bug or a missing index. Raised for
   * migrations, which legitimately take longer to build an index.
   */
  statementTimeoutMs?: number;
  /** Shows up in pg_stat_activity, so a stuck connection can be attributed. */
  applicationName?: string;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
}

/**
 * Whether this connection needs TLS.
 *
 * Anything that is not loopback is assumed to be a managed database reached
 * over a network, and gets TLS. A connection string that already says
 * `sslmode=` is left alone - the operator has been explicit and overriding
 * them would be worse than obeying.
 *
 * Certificate verification stays on. Providers that need their own CA should
 * pass `sslmode=verify-full` with `sslrootcert`, not have verification quietly
 * disabled here - `rejectUnauthorized: false` accepts any certificate, which
 * is indistinguishable from having no TLS against an active attacker.
 */
function needsTls(connectionString: string): boolean {
  if (/[?&]sslmode=/i.test(connectionString)) return false;
  try {
    const { hostname } = new URL(connectionString);
    return !["localhost", "127.0.0.1", "::1", ""].includes(hostname);
  } catch {
    return false;
  }
}

/**
 * Builds the pool.
 *
 * Sizing: `max` is per process, and Postgres counts connections across all of
 * them. A managed instance with a 100-connection ceiling and four API replicas
 * at 10 each leaves little room for migrations or a console session, so this
 * stays small by default and is raised deliberately. Behind PgBouncer in
 * transaction mode the number matters less - which is the arrangement
 * `withTenant` is already written for, since it scopes the tenant
 * transaction-locally rather than on the session.
 */
export function createPool(connectionString: string, options: number | PoolOptions = {}): Pool {
  const opts: PoolOptions = typeof options === "number" ? { max: options } : options;

  return new PgPool({
    connectionString,
    max: opts.max ?? 10,
    // A connection that cannot be established has to fail rather than hang: a
    // request waiting forever on a pool checkout looks like a slow database and
    // is actually a dead one.
    connectionTimeoutMillis: opts.connectionTimeoutMs ?? 10_000,
    // Managed databases and poolers drop idle connections on their own; letting
    // them go first avoids handing out a socket the other end has closed.
    idleTimeoutMillis: opts.idleTimeoutMs ?? 30_000,
    keepAlive: true,
    application_name: opts.applicationName ?? "belegbox",
    statement_timeout: opts.statementTimeoutMs ?? 30_000,
    ...(needsTls(connectionString) ? { ssl: { rejectUnauthorized: true } } : {}),
  });
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
