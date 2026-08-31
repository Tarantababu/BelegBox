# @belegbox/db

Schema, tenant isolation, and the archive writer's storage layer.

## Tenant isolation

Every query runs through `Db.withTenant(tenantId, fn)`, which opens a
transaction and calls:

```sql
SELECT set_config('app.tenant_id', $1, true)
```

Two details carry the whole guarantee.

**`true` means transaction-local.** A plain `SET` persists on the pooled
connection and is handed to whoever gets it next — with PgBouncer in
transaction pooling mode, that is how tenant isolation silently switches itself
off in production. There is a test that recycles the pool and proves the scope
does not follow the connection.

**The parameter is bound, not interpolated.** A tenant id can never carry SQL,
and `withTenant` rejects anything that is not a UUID before it gets that far.

Row Level Security does the enforcing from there. `withTenant` is the only path
to tenant data; there is no unscoped read.

### RLS is only as strong as the role

`FORCE ROW LEVEL SECURITY` binds the table **owner** to the policy. It does not
bind a superuser or a role holding `BYPASSRLS`, and nothing in PostgreSQL can —
those roles ignore policies by definition.

So the isolation guarantee rests on an operational rule, and there is a test
asserting it:

> `belegbox_app` owns no tables, is not a superuser, and does not hold
> `BYPASSRLS`.

Someone will eventually want to grant one of those temporarily to unblock a
migration. The test is there to make that a deliberate act with a failing build
attached, rather than a quiet one.

`tenants` is deliberately **not** forced: provisioning has to insert the row
that defines the scope, which no tenant-scoped policy can satisfy. The owner
provisions; the application role stays subject to the policy.

## Append-only

`audit_log` and `archive_chain` get `SELECT` and `INSERT` only — no `UPDATE`,
no `DELETE`, for any application role. Triggers refuse the same operations
independently, so a grant widened by mistake still cannot rewrite history. The
triggers refuse a superuser too, which the grants cannot.

An archived document is likewise sealed: once `archived_at` is set, its
`raw_sha256`, `raw_object_key`, `size_bytes` and `tenant_id` are immutable.
Moving them would turn every inclusion proof over that day into a lie.

## Archive writer

Documents are archived, days are sealed, and each day's link names the previous
day's Merkle root. Three rules the code enforces rather than documents:

- **A sealed day is closed.** Archiving into a day that already has a chain link
  is refused — the document would be in the database but outside the tree that
  covers it, which is precisely the hole an auditor looks for.
- **The chain only moves forward.** Sealing a day at or before the last sealed
  one would rewrite what later days already point at.
- **An empty day still seals.** A gap in the chain is indistinguishable from a
  deletion, and GoBD *Vollständigkeit* is the property being demonstrated.

The tree itself is in `@belegbox/archive`: RFC 6962, SHA-256, domain-separated
leaves and nodes. `GET /v1/archive/proof/:id` returns everything needed to
verify a document without trusting this server.

## Running the tests

RLS, `FORCE`, triggers and grants have no in-memory substitute, so these need a
real PostgreSQL. Without `DATABASE_URL` they skip; CI runs a service container.

```bash
docker compose up -d postgres
DATABASE_URL=postgres://belegbox:belegbox@localhost:5432/belegbox pnpm --filter @belegbox/db test
```

The suite connects as the given role to migrate and provision, then reconnects
as `belegbox_app` for everything tenant-scoped — the same split production uses.

## Migrations

Forward-only, digest-checked. Editing a migration that has already run is
refused outright: it is the classic way for two environments to drift while
both report being up to date.

```bash
DATABASE_URL=... pnpm --filter @belegbox/db migrate
```
