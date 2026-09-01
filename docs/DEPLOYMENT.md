# Deployment

## Vercel hosts one of the five pieces

This is worth being blunt about before you start, because the shape of the
system does not match a single-platform deploy.

| Piece | What it is | Vercel? |
|---|---|---|
| `apps/web` | Next.js 15, no workspace dependencies, talks to the API over HTTP | **Yes** |
| `apps/api` | Fastify, long-lived PostgreSQL pool, streams binary ZIPs | No — needs a container host |
| `apps/worker` | Long-running inbound-mail webhook receiver | No — needs a container host |
| `services/mustang-svc` | **Java 21** running the official KoSIT validator | **Never** — Vercel has no JVM |
| PostgreSQL 16 | RLS, append-only triggers, `pg_trgm` | Managed provider |
| Object storage | S3 with Object Lock in COMPLIANCE mode | AWS S3 or compatible |

The one that cannot be worked around is `mustang-svc`. It runs the KoSIT
validator — the official one, the one whose judgement *is* the form verdict.
There is no JavaScript reimplementation, and writing one would defeat the point:
the product's claim is that an authority's validator judged the form. Without
that service the form verdict degrades to `unknown` and says so on screen, which
is honest but is half the product missing.

So a working deployment is:

- **Vercel** — `apps/web`, root directory `apps/web`.
- **A container host** (Fly.io, Railway, Render, ECS, a VM) — `apps/api`,
  `apps/worker`, and `services/mustang-svc`.
- **Managed PostgreSQL** — Neon, Supabase, RDS, Cloud SQL.
- **S3** — a bucket created *with object locking enabled*. It cannot be turned
  on afterwards.

## Order

### 1. Database

Create the database, then run the migrations from a machine that can reach it:

```bash
DATABASE_URL='postgres://...' pnpm --filter @belegbox/db migrate
```

The migrator creates `pgcrypto` and `pg_trgm` itself. On a managed provider the
connecting role needs to be allowed to create extensions — on Neon and Supabase
the default owner is.

Then create the application role. **The API must not connect as the owner or as
a superuser**: `audit_log`, `archive_chain`, `documents` and
`verfahrensdokumentationen` are append-only by grant as well as by trigger, and
Row Level Security does not bind a superuser at all. `assertRlsEnforced()`
refuses to start against such a connection, which is the check that caught this
in development.

```sql
CREATE ROLE belegbox_app LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE belegbox TO belegbox_app;
GRANT USAGE ON SCHEMA public TO belegbox_app;
-- The migrations grant the per-table privileges, including the deliberate
-- absence of UPDATE and DELETE on the append-only tables.
```

Point `DATABASE_URL` at that role, not at the owner.

**Connection sizing.** `max` is per process and PostgreSQL counts across all of
them; four API replicas at 10 each is 40 before migrations or a console session.
Use the provider's pooled endpoint (Neon's `-pooler` host, Supabase's port 6543)
and keep `max` small. `withTenant` scopes the tenant with
`set_config(..., true)` — transaction-local — so it is already correct behind
PgBouncer in transaction mode, where a session-level `SET` would leak one
tenant's scope onto the next request.

TLS is on automatically for any non-loopback host, with certificate
verification enabled. If your provider needs its own CA, pass `sslmode` and
`sslrootcert` in the URL rather than disabling verification.

### 2. Object storage

```bash
aws s3api create-bucket --bucket belegbox-raw --object-lock-enabled-for-bucket
```

Object locking **cannot be enabled on an existing bucket**. Set
`S3_OBJECT_LOCK_MODE=COMPLIANCE` in production: GOVERNANCE can be lifted by
anyone holding `s3:BypassGovernanceRetention`, which is not the property § 14b
UStG needs. COMPLIANCE cannot be lifted by anyone, including the account root,
which also means a mistake is permanent for ten years.

### 3. mustang-svc

```bash
docker build -t belegbox-mustang services/mustang-svc
```

Before it is worth deploying, pin the versions. Every value in
`services/mustang-svc/versions.properties` that reads `UNPINNED` must name a
resolved build — requirement R-2 stores those versions on every finding so a
2026 verdict can be re-derived in 2033, and `UNPINNED` makes that impossible.
Run `services/mustang-svc/scripts/fetch-validator-config.sh` to install the
validator configuration; the script verifies its digest.

### 4. API and worker

```bash
docker build --build-arg APP=api    -t belegbox-api .
docker build --build-arg APP=worker -t belegbox-worker .
```

Point the platform's health check at **`/health/ready`**, not `/health`.
`/health` is liveness and deliberately does not touch the database — a liveness
probe that fails during an outage restarts every replica and turns a
recoverable outage into a crash loop. `/health/ready` returns 503 when the
database is unreachable and reports which features the instance can serve.

### 5. Web

On Vercel: root directory `apps/web`, framework Next.js. Set `API_URL` to the
API's public origin. It is read in server components only and never reaches the
browser.

Set `CORS_ORIGINS` on the API to the Vercel domain. The API answers with tenant
data and session cookies, so the list is explicit and never a reflected origin.

## Before the first real customer

Two of these are hard gates, and neither can be cleared by writing more code:

- **The explain templates are unreviewed.** All 22 carry `approved: false`. The
  API refuses to render unapproved wording unless
  `ALLOW_UNAPPROVED_TEMPLATES=true`, which must stay `false` in production. They
  describe tax law to users, and § 2–5 StBerG reserve tax advice to
  Steuerberater. This needs a lawyer, not a deploy.
- **The DATEV column list has not been checked** against DATEV's own
  Buchungsstapel v13 layout. DATEV matches each row's width against the caption
  line, so a miscount breaks every row. A Steuerberater's test import settles
  it, and the same import should open the Beleg bundle.

And the operational ones: `versions.properties` must be pinned (R-2), and the
S3 bucket must have object locking on before the first document is archived.
