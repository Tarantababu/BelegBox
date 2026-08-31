# Belegbox

German e-invoicing compliance platform. Two verdicts on every document: the
**form** verdict from the official KoSIT validator, and the **content** verdict
from rules KoSIT does not check. A syntactically perfect invoice can still be
materially wrong, and that pairing is the product.

Plan of record: [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md).

## Quick start

```bash
pnpm install
pnpm build
pnpm test
pnpm validate --offline corpus/*.xml
```

`--offline` skips L1 and L2 and runs detection plus D-001 alone. Drop the flag
once `mustang-svc` is up:

```bash
pnpm svc:up
pnpm validate corpus/gastro-beverage-7pct-01.xml
```

Without the validator the form verdict reads `unknown`. It is never guessed —
a wrong verdict on a tax document is worse than no verdict.

## Layout

Directories exist when their work begins, not before. A module being on the
roadmap does not mean its turn has come.

| Path | Status |
|---|---|
| `packages/core-invoice` | **Sprint 0.** Format, syntax and profile detection, including the ZUGFeRD profile legality check (D-001) |
| `packages/validation` | **Sprint 0.** Layered pipeline, mustang-svc client, verdict derivation |
| `apps/cli` | **Sprint 0.** `belegbox validate` |
| `services/mustang-svc` | **Sprint 0.** JVM sidecar. L1 XSD implemented, L2 KoSIT wiring is week 2-3 |
| `corpus` | **Sprint 0.** Seven hand-authored fixtures with committed snapshots |
| `packages/ingest` | **Week 1.** Provider adapters, sender authentication, PDF/A-3 extraction, inbox addressing |
| `apps/worker` | **Week 1.** Inbound webhook, idempotency, write-once object store |
| `packages/archive` | **Week 2.** RFC 6962 Merkle tree, day chain, inclusion proofs |
| `packages/db` | **Week 2.** Schema, RLS, append-only enforcement, archive writer |
| `apps/api` | **Week 2.** Fastify `/v1`, archive proof endpoint |
| `apps/web` | Week 4-5. Next.js, consumes `/v1` |
| `packages/rules-engine` | Week 3-4. YAML → AST → evaluator |
| `packages/explain` | Week 4-5. Versioned templates, DE + TR |
| `packages/payments` | Week 5-6. EPC-QR, pain.001 |
| `packages/datev` | Week 5-6. EXTF writer |
| `apps/mobile` | F3 |

## Receiving mail

```bash
INGEST_PROVIDER=postmark \
POSTMARK_WEBHOOK_USER=hook POSTMARK_WEBHOOK_PASSWORD=dev-secret \
pnpm --filter @belegbox/worker dev
```

`POST /inbound/postmark` and `POST /inbound/mailgun`. Both providers are
implemented behind one `IngestSource`; **Postmark is the default** — its
inbound parsing is more consistent and its 35 MB attachment ceiling is far
above any real e-invoice. Switching is one environment variable.

Until week 2 the worker writes raw bytes to `.data/ingest/objects/` with the
`wx` flag, so a second write of the same digest fails instead of overwriting.
That is a deliberate rehearsal of S3 Object Lock: code that assumes it can
re-put an object breaks in development rather than in a Compliance-mode bucket.

## Database

```bash
DATABASE_URL=postgres://belegbox:belegbox@localhost:5432/belegbox \
pnpm --filter @belegbox/db migrate
```

Tenant isolation is Row Level Security, entered only through
`Db.withTenant(id, fn)`. It sets `app.tenant_id` **transaction-locally**, which
is what keeps the scope from following a pooled connection to the next request
under PgBouncer. `audit_log` and `archive_chain` are append-only by grant *and*
by trigger.

RLS binds a role that cannot step around it, so `belegbox_app` owns no tables,
is not a superuser, and holds no `BYPASSRLS` — asserted by a test, because
someone will eventually want to grant one of those to unblock a migration.
Details in [packages/db/README.md](packages/db/README.md).

## Two invariants

**The form verdict comes from L1 and L2 alone.** L3 and L4 cannot touch it. The
`TenantSeverity` type excludes `form_error`, so a tenant-authored rule that
tries to produce one does not compile.

**Rules are selected by the document's issue date (BT-2), never by `now()`.** A
2025 invoice is judged by the 2025 rules — otherwise the archive re-judges
itself every time the law changes.

Two more that ingest adds:

**Nothing inbound is discarded.** A PDF with no embedded XML is still a document
the tenant must keep (§ 14b UStG). It is stored and marked `not_einvoice`, never
dropped.

**Sender authentication warns, it never blocks.** A supplier with a broken SPF
record still sends real invoices. The result is stored on the document, shown in
the UI and fed to D-008 — a silently dropped invoice is worse than a flagged
one.

And one the archive adds:

**A sealed day is closed.** A document cannot be archived into a day that
already has a chain link, and the chain only seals forward. Either would leave a
document in the database but outside the tree that is supposed to cover it.

## What is not verified yet

Scaffolded on a machine with no JDK and no Docker, so:

- `services/mustang-svc` has **not been compiled or run**. The CI `jvm` job
  builds it, boots it and probes `/health`; that is the first real check.
- `docker-compose.yml` has not been brought up. The database suite was verified
  against a throwaway PostgreSQL 16 cluster instead, and runs in CI against a
  service container.
- Object storage is still the filesystem stand-in. S3 with Object Lock is week
  3; the `wx` write is a rehearsal of it, not the thing itself.
- Every version in `services/mustang-svc/versions.properties` reads `UNPINNED`.
  Pinning them against a resolved build is F1 week 1 and blocks storing any
  verdict (R-2).
