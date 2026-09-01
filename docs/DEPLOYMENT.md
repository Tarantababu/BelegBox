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

One command, run once, as the database owner:

```bash
DATABASE_URL='postgres://<owner>:<pw>@<host>/<db>' \
APP_DB_PASSWORD="$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")" \
pnpm --filter @belegbox/db provision
```

**Order matters, and it is not the obvious one.** Migration 0002 grants
privileges to `belegbox_app`, so the role has to exist *before* the migrations
run. Running `migrate` first on a virgin database fails with
`role "belegbox_app" does not exist` — which never shows up locally, because the
Docker init script or a test run has already created the role. `provision` does
it in the right order.

It then does the thing worth having: it connects **as `belegbox_app`** and
proves the result. Row Level Security has to be binding on that connection, and
`audit_log`, `archive_chain` and `documents` have to refuse an UPDATE from it.
Every step before that can succeed while the outcome is still wrong — an
owner-owned connection, a `BYPASSRLS` granted to unblock something — and tenant
isolation would be off with nothing saying so. If the role can bypass RLS,
provisioning stops and says why.

`APP_DB_PASSWORD` has no default. A default is how `belegbox` reaches
production, and the role it protects holds every tenant's invoices.

**The API must never connect as the owner or a superuser.** `audit_log`,
`archive_chain`, `documents` and `verfahrensdokumentationen` are append-only by
grant as well as by trigger, and RLS does not bind a superuser at all.
`assertRlsEnforced()` refuses to start against such a connection.

**On Neon**, run `provision` against the direct (non-pooled) endpoint — creating
a role and running DDL wants a real session — then point the API and worker at
the **pooled** endpoint (`-pooler` in the host). `withTenant` scopes the tenant
with `set_config(..., true)`, which is transaction-local, so it is already
correct behind PgBouncer in transaction mode where a session-level `SET` would
leak one tenant's scope onto the next request.

**Connection sizing.** `max` is per process and PostgreSQL counts across all of
them; four API replicas at 10 each is 40 before migrations or a console session.
Keep it small and let the pooler do the work.

TLS is on automatically for any non-loopback host, with certificate verification
enabled. If your provider needs its own CA, pass `sslmode` and `sslrootcert` in
the URL rather than disabling verification.

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
flyctl launch --config fly.mustang.toml --no-deploy   # first time only
flyctl deploy --config fly.mustang.toml
```

The validator configuration is fetched and digest-checked **during the image
build** and baked in. It is not in the repository — it is a 40 MB third-party
release — and it is not optional either: without it the service starts, answers
`/health` with `ok`, and returns a form verdict of `unknown` for every document
ever sent to it. Nothing downstream can tell that apart from a validator with
nothing to say, which is why the build fails instead if `scenarios.xml` is
missing.

`fly.mustang.toml` has **no `services` block on purpose**. The validator is
reachable only over Fly's private network as `belegbox-mustang.internal`; it has
no authentication of its own and must never be public. The service binds `::`
rather than the wildcard, because that private network is IPv6-only and a
process listening on IPv4 alone is unreachable by name while looking perfectly
healthy.

It also stays always-on. This is a JVM loading the KoSIT scenarios and their
Schematron transforms, which takes several seconds, and the client gives up at
20 — a suspended machine turns the first validation after a quiet period into
`unknown` on a document that is perfectly valid.

Before it is worth deploying, pin the versions. Every value in
`services/mustang-svc/versions.properties` that reads `UNPINNED` must name a
resolved build — R-2 stores those versions on every finding so a 2026 verdict
can be re-derived in 2033, and `UNPINNED` makes that impossible.

### 4. API and worker

```bash
flyctl launch --config fly.api.toml    --no-deploy    # first time only
flyctl launch --config fly.worker.toml --no-deploy

flyctl secrets set --app belegbox-api \
  DATABASE_URL='postgres://belegbox_app:...@ep-...-pooler.../belegbox' \
  S3_BUCKET_RAW=... S3_REGION=eu-central-1 \
  S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... \
  WEB_URL=https://... CORS_ORIGINS=https://... INBOX_DOMAIN=...

flyctl deploy --config fly.api.toml
flyctl deploy --config fly.worker.toml
```

`DATABASE_URL` must name `belegbox_app` and use the **pooled** endpoint. The API
calls `assertRlsEnforced()` before it listens, so a connection that can bypass
Row Level Security stops the deploy rather than serving one tenant's invoices to
another.

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
