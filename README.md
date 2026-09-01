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
| `packages/rules-engine` | **Week 3.** YAML → AST → evaluator, dry-run harness |
| `rulesets` | **Week 3.** `gastro-de`, `handwerk-bau-de` |
| `packages/explain` | **Week 4.** Versioned templates, DE + TR, StBerG lint |
| `apps/web` | **Week 4-5.** Next.js. M-01 setup, M-02 inbox, M-03 detail |
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

## The two content layers

```bash
pnpm validate --offline --ruleset rulesets/gastro-de.yaml corpus/gastro-beverage-7pct-01.xml
```

**L3 is code.** D-001 to D-009 need lookups, history and arithmetic a
declarative rule cannot express, and they are the same for every tenant.
D-007, D-008 and D-009 are not e-invoicing checks at all — duplicate invoice,
IBAN in the wrong country, amount far outside the supplier's usual range. Those
are invoice-fraud checks, and no competing validator runs them.

**L4 is YAML**, one ruleset per sector. Sector difference is data, not code —
`gastro-de` and `handwerk-bau-de` ship today, and adding a sector adds a file.

The `compute` expressions run through a purpose-built arithmetic parser, never
`eval` or `new Function`. Rule YAML becomes tenant-authored input in F3, at
which point an expression string is untrusted code running on our servers. The
grammar is numbers, four operators, parentheses and whitelisted field names —
nothing else parses.

## Explanations

```bash
pnpm validate --offline --ruleset rulesets/gastro-de.yaml --explain tr \
  corpus/gastro-beverage-7pct-01.xml
```

Explanations are **versioned YAML templates, rendered by a pure function** — no
LLM at request time. An LLM's part is drafting the YAML before review, never
rendering at the moment a user reads it. That removes the hallucination risk
from a tax explanation, removes an AVV subprocessor, and makes a stored verdict
re-derivable in 2033.

§ 2–5 StBerG reserve tax advice to Steuerberater, so the schema is built to make
advice **unwriteable**:

- A template has `observation` (what this document says) and `legal_basis` (what
  the law says in general). There is no field for what the reader should do
  about their tax position.
- The **disclaimer belongs to the renderer**, not the template. A template that
  even declares the field is refused — otherwise one locale eventually ships
  without it, and that is the locale nobody reviewed.
- A **lint refuses advisory wording** at load: `Du musst`, `richtig wäre`,
  `doğrusu`, `yapman gereken`. The distinction it rests on is grammatical
  person — German `muss` states the law, `Du musst` instructs the reader;
  Turkish `zorundadır` states it, `zorundasın` instructs. The v2 prototype's
  own strings are in the test suite as the cases that must fail.
- `basis_kind` separates law from heuristic. D-008 and D-009 are Belegbox's own
  fraud signals, and a template declaring one **may not cite a statute** —
  dressing a heuristic up as law is the more damaging mistake.

Every template ships `approved: false` until a lawyer reviews the wording
(Ek A). Production refuses to render an unapproved one; the CLI renders them and
says so.

## Running the whole thing

```bash
DATABASE_URL=postgres://postgres@localhost:5432/belegbox pnpm --filter @belegbox/api seed
DATABASE_URL=postgres://belegbox_app:belegbox@localhost:5432/belegbox pnpm --filter @belegbox/api start
pnpm --filter @belegbox/web dev
```

Note the two different roles. The seeder provisions tenants and runs
migrations, which needs the owner connection. **The API must not use it.**

The API refuses to start against a role that can bypass Row Level Security —
superuser or `BYPASSRLS`. That check exists because pointing it at the
`postgres` superuser during development silently disabled tenant isolation, and
the screens rendered another tenant's invoices without a hint that anything was
wrong. A test already asserted `belegbox_app` had no such privileges; nothing
had checked the connection the process actually opened.

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

And two the rules engine adds:

**A rule that cannot reach an answer abstains.** VIES being unreachable, a
comparison against a missing amount, a supplier with no history — each produces
a warning that says so, never a content error. A tax authority outage must not
tell a customer their invoice is wrong.

**A missing field is not zero.** `compute` refuses to resolve one, because a
VAT gap that silently reads 0.00 looks like a harmless finding.

And one from the explain layer:

**No template means the raw validator output, never an invented explanation.**
An honest "we have not written this one yet" beats a fluent paragraph about a
tax rule nobody checked.

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
