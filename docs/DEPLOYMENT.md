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
aws s3api create-bucket \
  --bucket belegbox-archive \
  --region eu-central-1 \
  --create-bucket-configuration LocationConstraint=eu-central-1 \
  --object-lock-enabled-for-bucket
```

`--object-lock-enabled-for-bucket` **cannot be added to an existing bucket**.
Getting it wrong means creating a second bucket and re-archiving, so it is worth
checking before the first document arrives. It also turns on versioning, which
Object Lock requires.

Production uses `S3_OBJECT_LOCK_MODE=COMPLIANCE`. GOVERNANCE can be lifted by
anyone holding `s3:BypassGovernanceRetention`, which is not the property § 14b
UStG needs. COMPLIANCE cannot be lifted by anyone, including the account root,
until the retain-until date passes — which also means a mistake is permanent for
ten years.

**Not every S3-compatible store implements Object Lock.** Fly's Tigris was tried
and does not: the retention came back unset, and a "locked" version deleted
successfully. Cloudflare R2 does not support it either. AWS S3, Backblaze B2 and
Wasabi do. Run `packages/storage`'s suite against any candidate before trusting
it — it writes an object under retention and then tries to delete it.

The application makes exactly three calls — `PutObject`, `GetObject`,
`HeadObject` — because `ObjectStore` has no delete method at all. So the IAM
policy it runs under can say so:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "WriteAndReadArchivedOriginals",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:PutObjectRetention",
        "s3:GetObject",
        "s3:GetObjectRetention"
      ],
      "Resource": "arn:aws:s3:::belegbox-archive/*"
    },
    {
      "Sid": "SoAMissingKeyIs404AndNot403",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::belegbox-archive"
    },
    {
      "Sid": "NeverRemoveAnything",
      "Effect": "Deny",
      "Action": [
        "s3:DeleteObject",
        "s3:DeleteObjectVersion",
        "s3:BypassGovernanceRetention",
        "s3:PutBucketObjectLockConfiguration"
      ],
      "Resource": [
        "arn:aws:s3:::belegbox-archive",
        "arn:aws:s3:::belegbox-archive/*"
      ]
    }
  ]
}
```

`s3:ListBucket` is there for a reason that is easy to miss: without it, S3
answers `403 AccessDenied` for a key that does not exist instead of `404
NoSuchKey`. The Beleg bundle distinguishes "the original is missing from
storage" from "the read failed" on exactly that error, and would otherwise
report every missing document as an unexplained failure.

The explicit `Deny` is belt and braces. COMPLIANCE retention already refuses a
delete, and the code has no method that could ask for one; the policy makes it
true at a third level, where a future change to either cannot quietly undo it.

### 3. mustang-svc

```bash
flyctl apps create belegbox-mustang --org personal    # first time only
flyctl deploy --config fly.mustang.toml --remote-only
```

Every image builds with the **repository root** as its context, including this
one — the Dockerfile's paths are `services/mustang-svc/...` for that reason.
Fly ties the build context to the working directory and resolves `dockerfile`
relative to the config, so a service-relative Dockerfile deployed from the root
picks up the wrong file and fails on a `COPY` that looks unrelated. One context
for all three beats a special case that only appears mid-deploy.

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

On Vercel: **Root Directory must be `apps/web`.** Framework Next.js. Deploy from
the connected git repository, not by uploading `apps/web` — the CLI would send
that directory alone, and `pnpm install --frozen-lockfile` then fails because
the lockfile and `pnpm-workspace.yaml` live at the repository root. Vercel
clones the whole repo and changes into the root directory, which is what makes
the workspace resolvable.

The root directory is not settable from the CLI; it is a project setting (or a
`PATCH` to `/v9/projects/<id>`). Left at `.`, the build runs against the
monorepo root and produces no Next.js output.

Pointing a Vercel project at `apps/api` or `apps/worker` does not fail in a way
that says so. The Turbo build succeeds — `tsc` compiles to `dist/` and every
task reports exit 0 — and then the deployment fails at the end because a Fastify
server that calls `listen()` has nothing Vercel can serve. The build summary
looks entirely healthy; the target is simply wrong. Those two go to Fly.

Set `API_URL` to the API's public origin. It is read in server components only
and never reaches the browser. It is declared in `turbo.json` under the build
task's `env`, which is what makes it part of the cache key: without that,
changing `API_URL` in the Vercel project settings gets a **cache hit** and
redeploys the previous build with the old origin still baked into the
prerendered routes.

Set `CORS_ORIGINS` on the API to the Vercel domain. The API answers with tenant
data and session cookies, so the list is explicit and never a reflected origin.

## Inbound mail

The worker exposes `POST /inbound/postmark`, authenticated with HTTP Basic
credentials embedded in the webhook URL — Postmark does not sign inbound
webhooks, so that password is the only thing between the internet and an
endpoint that writes to the archive. It must come from a generator.

Three things have to line up, and only the last is in this repository:

1. **A domain you control.** `INBOX_DOMAIN` is baked into every tenant's inbox
   address at signup, so changing it later strands every address already given
   to a supplier. Decide it before the first real tenant.
2. **MX records** pointing at the provider's inbound servers, plus their SPF and
   DKIM records. SPF, DKIM and DMARC results are stored with each document —
   the mailbox is where a forged invoice with a swapped IBAN arrives, so the
   verdict is part of the evidence, not a spam score.
3. **The provider's inbound webhook** pointed at
   `https://<worker>/inbound/postmark`, with the Basic credentials in the URL:
   `https://hook:<POSTMARK_WEBHOOK_PASSWORD>@<worker>/inbound/postmark`.

Redelivery is safe: the provider's message id is claimed once, and a second
delivery of the same message answers `{"status":"duplicate","documents":0}`
without archiving anything twice.

`RULESET_FILE` must be set on **both** the API and the worker. Without it the
pipeline still runs L1–L3 and returns a content verdict, so nothing looks
broken — it is simply a weaker verdict, and a document that should be flagged
comes back clean. Both processes now say so at startup rather than degrading
quietly.

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
