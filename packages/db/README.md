# @belegbox/db

Sprint 0 ships the extensions and the application role only. Tables land in F1
week 2, alongside the two isolation guarantees they depend on.

## Two rules that are not negotiable

**Tenant isolation is Row Level Security, not an application filter.** Every
query runs under `SET LOCAL app.tenant_id = '…'` inside its transaction. Note
`LOCAL`: with PgBouncer in transaction pooling mode a bare `SET` leaks into
whatever connection is handed out next, which silently turns tenant isolation
off. The week 2 work includes a lint rule for this and an integration test that
proves tenant B cannot read tenant A's document by id.

**`audit_log` and `archive_chain` are append-only.** No application role gets
`UPDATE` or `DELETE` on them. The application connects as `belegbox_app`, which
does not own the tables, so the grant is the enforcement.

## Migration tool

Not chosen yet. The decision is week 2 and only needs to satisfy: plain SQL
files, forward-only, checked into the repo, and runnable from CI without a
Node runtime in the container.

## Schema

The full data model and the deltas against PRD § 9.4 - reproducibility columns
(R-2), rule effective dating (R-1), the correction chain (R-3), email forensics,
number ranges (R-4) and dispatch evidence (R-5) - are in
`docs/IMPLEMENTATION_PLAN.md` § 3.3.
