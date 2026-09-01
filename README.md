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
| `services/mustang-svc` | **Wired.** JVM sidecar running the official KoSIT validator, configuration pinned |
| `corpus` | **Sprint 0.** Seven hand-authored fixtures with committed snapshots |
| `packages/ingest` | **Week 1.** Provider adapters, sender authentication, PDF/A-3 extraction, inbox addressing |
| `apps/worker` | **Wired.** Inbound webhook, WORM archive, validation, PostgreSQL |
| `packages/storage` | **Wired.** S3 Object Lock, with the undeletability proof |
| `packages/archive` | **Week 2.** RFC 6962 Merkle tree, day chain, inclusion proofs |
| `packages/db` | **Week 2.** Schema, RLS, append-only enforcement, archive writer |
| `apps/api` | **Week 2.** Fastify `/v1`, archive proof endpoint |
| `packages/rules-engine` | **Week 3.** YAML → AST → evaluator, dry-run harness |
| `rulesets` | **Week 3.** `gastro-de`, `handwerk-bau-de` |
| `packages/explain` | **Week 4.** Versioned templates, DE + TR, StBerG lint |
| `packages/auth` | **Wired.** Passwords, sessions, API keys, TOTP |
| `packages/mail` | **Wired.** Outbound mail port, Postmark and console senders |
| `packages/payments` | **Week 5.** GiroCode (EPC-069-12), SEPA pain.001, IBAN validation |
| `apps/web` | **Week 4-7.** Next.js. M-01 setup, M-02 inbox, M-03 detail, M-06 export, M-11 Verfahrensdokumentation |
| `packages/datev` | **Week 6.** EXTF Buchungsstapel writer, chart of accounts |
| `packages/verfahrensdoku` | **Week 7.** GoBD Verfahrensdokumentation, generated from the running system |
| `apps/mobile` | F3 |

## Receiving mail

```bash
INGEST_PROVIDER=postmark \
POSTMARK_WEBHOOK_USER=hook POSTMARK_WEBHOOK_PASSWORD=dev-secret \
DATABASE_URL=postgres://belegbox_app:belegbox@localhost:5432/belegbox \
S3_BUCKET_RAW=belegbox-raw-dev S3_ENDPOINT=http://localhost:9000 \
MUSTANG_SVC_URL=http://localhost:8081 \
RULESET_FILE=rulesets/gastro-de.yaml \
pnpm --filter @belegbox/worker dev
```

One message becomes: bytes in the WORM archive, a verdict from both validation
layers, and a row in PostgreSQL under the recipient's tenant. Validation runs at
ingest rather than in a later pass, so a document is never visible without a
verdict — a row that says nothing is worse than no row, because the inbox shows
it as unremarkable and the entire point is that some of them are not.

Two details that took a second attempt to get right:

**Deduplication and writing happen together.** The obvious shape — ask whether a
message was seen, process it, then record it — has a gap between the question
and the answer that two concurrent redeliveries walk straight through. The claim
is an atomic `INSERT … ON CONFLICT DO NOTHING RETURNING` inside the same
transaction as the documents, so a rollback releases it and a failed attempt
gets a clean retry.

**Unroutable mail is recorded, not discarded.** A message to an address that
matches no inbox is stored with a null tenant, which the RLS policy renders
invisible to every tenant while remaining visible to operators. Misdirected mail
and probes are the busiest part of the inbound attack surface.

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

## Preparing a payment

Belegbox produces payment data. The user carries it to their own bank.

That distinction is the whole design. Initiating a payment on someone's behalf
is a Zahlungsauslösedienst under ZAG § 1 Abs. 1 Nr. 7 — BaFin authorisation and
50.000 EUR of capital. So there is a GiroCode to scan and a `pain.001` file to
upload, no account credentials are held, no money moves through anything here,
and the heading says *vorbereiten*, never *bezahlen*.

**The QR is a real one.** The v2 prototype drew a deterministic module pattern
with three finder squares: convincing on screen, unscannable. The test decodes
the rendered code back to its payload, which is the only assertion that would
have caught that. ECC level M, because EPC-069-12 requires it.

**The payload is twelve elements**, not the prototype's eleven, with the
beneficiary name truncated at 70 characters and a hard 331-byte ceiling. Nothing
reaches the encoder unvalidated: a bad IBAN is refused rather than encoded,
because a QR that scans into a banking app with a wrong account is discovered on
a payment screen.

**Both pain.001 versions.** The PRD names `.09`; many German portals still take
only `.03`. A file the user's bank rejects is not a smaller failure than no file,
so the format is theirs to choose.

Payment details come from the parsed invoice, never from the caller. An endpoint
that accepted an IBAN as input would happily encode one an attacker chose — and
D-008 exists because a swapped IBAN is the commonest shape of invoice fraud.

## The DATEV export

The monthly hand-off to the Steuerberater, and the point where a compliance tool
either saves an afternoon or creates one.

**Windows-1252, not UTF-8.** DATEV reads ANSI. A UTF-8 file imports with every
umlaut broken, which is discovered by the Steuerberater rather than here. What
CP1252 cannot carry is transliterated the German way rather than dropped, so a
Turkish supplier name survives as `Sahin` and `Getränke Müller` keeps its
umlauts as single bytes. The API returns the file base64-encoded for exactly
this reason: JSON is UTF-8, and round-tripping the bytes through it would undo
the encoding the format depends on.

**Belegdatum is DDMM, four characters.** The v2 prototype wrote eight
(defect P-3). DATEV derives the year from the Wirtschaftsjahr in the header, and
an eight-character date is rejected on import.

**The VAT category picks the account before the rate does.** A reverse-charge
invoice under § 13b UStG books to 3120 with Buchungsschlüssel 94, not to the
ordinary expense account — booking it as an ordinary expense claims input tax
that was never charged, which is the exact error D-002 catches upstream. This is
why the export reads `documents.parsed` rather than the list projection: the
projection has no VAT category, and an export built on it would silently book
every reverse-charge invoice wrong.

**Accounts are data, not code.** SKR03 and SKR04 ship as defaults and a ruleset
overrides them per tenant. The wrong chart produces a stapel the Steuerberater
unpicks line by line, so it is a field on the export form rather than an
assumption.

Documents that are not e-invoices are skipped with a reason rather than booked
on a guess. The export is in every paid tier — the PRD makes that a deliberate
difference from the competitor, who puts it behind their top plan.

## The Verfahrensdokumentation

The document a Betriebsprüfer asks for, and the one place where generating
boilerplate would actively hurt the user.

GoBD Rz. 151-155 require the *business* to describe its own tax-relevant
processes. In an audit the business is held to that description, not to
Belegbox's marketing. Belegbox can therefore only generate the part of the
process that runs inside Belegbox, and two rules follow.

**Every statement names its source.** Each fact carries where it was read -
`tenants.retention_policy`, `archive_chain`, `versions.properties`,
`@belegbox/storage` - and the rendered page prints that source in a column
beside the value. A sentence nobody can trace back to a column is an assertion,
and this document exists to be evidence. Same discipline as R-2 on findings.

**Where Belegbox cannot see, it asks instead of filling in.** Paper invoices,
the till, who releases a payment, what happens after the DATEV export: thirteen
open items, each with the reason it cannot be answered automatically. The
document prints as a draft until they are answered. Boilerplate covering a
process the business does not actually follow is worse evidence than a blank,
because it is a written statement an auditor can disprove.

**It never certifies.** Whether a process satisfies the GoBD is a judgement for
the Steuerberatung or Wirtschaftsprüfung. `lint.ts` refuses "GoBD-konform",
"revisionssicher", "erfüllt die Anforderungen" and their neighbours at build
time, for the reason the StBerG lint exists: those sentences read well and
would survive a proofread. The lint judges the *authored* words only - a
business called "Rechtssicher GmbH" is entitled to its name, so prose keeps its
literal parts separate from the data spliced into it.

**Versions of the system, and versions of itself.** The validator versions come
from the running sidecar rather than a constant, because this Node process
cannot see which configuration the JVM loaded - and a separate fact reports the
versions that *actually judged this tenant's documents*, read off the stored
findings. That is the question an auditor asks: not what "formally correct"
would mean today, but what it meant when the invoice arrived.

The document itself is kept the same way. Rz. 154 wants a change history and
the retention of superseded fassungen, so `verfahrensdokumentationen` is
append-only like `audit_log`, and each fassung names the hash of the one before
it - the archive day chain's construction, for the same reason. The hash runs
over the content, not the rendered HTML: a changed margin must not look like a
changed process.

## The archive

Raw documents go to S3 with Object Lock, under a retention that runs to the end
of the tenth calendar year after receipt (§ 14b UStG). Two properties are worth
knowing:

**The store interface has no `delete`.** There is no legitimate caller for one
in a system that keeps invoices for a decade, so the interface cannot express
it and no incident produces a tempting one-liner.

**A plain delete still appears to succeed.** On a versioned bucket, `DELETE`
without a version id writes a delete marker: the object vanishes from a normal
read while the locked version sits untouched underneath. Retention protects the
bytes; it does not stop the archive from being made to *look* empty. There is a
test that pins both halves of that behaviour, because it is better learned now
than during an audit.

```bash
minio server ./data --address 127.0.0.1:9000 &
mc mb --with-lock local/belegbox-raw-dev
S3_TEST_ENDPOINT=http://127.0.0.1:9000 pnpm --filter @belegbox/storage test
```

Locking must be enabled when the bucket is created — it cannot be turned on
later. The suite is the Ek A pre-launch item ("prove undeletability") and refuses
to pass unless a real store refuses a real delete.

## The form verdict

```bash
cd services/mustang-svc && ./scripts/fetch-validator-config.sh && mvn package
java -jar target/mustang-svc.jar
MUSTANG_SVC_URL=http://localhost:8081 pnpm validate corpus/broken-br-co-15-01.xml
```

L1 and L2 are the **official KoSIT validator** — the same engine the ZRE and
OZG-RE portals run — with the XRechnung 3.0.2 configuration pinned by release
tag *and* SHA-256. A release replaced in place fails the checksum rather than
quietly changing what "valid" means, which is what R-2 asks for.

Both layers come from one engine because the configuration defines both: the
scenario picks the XSD for the syntax and the Schematron for the CIUS.

The two verdicts on the corpus, from the real validator:

| Fixture | Form (KoSIT) | Content (Belegbox) |
|---|---|---|
| `broken-br-co-15-01` | **fail** — BR-CO-15, BT-112 | pass |
| `gastro-beverage-7pct-01` | **pass** | **fail** — 48,04 € |

The second row is the product. The official validator passes that invoice
completely.

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

## Authentication

Two credentials, one answer. A browser presents an opaque session cookie; an
integrator presents `sk_live_…` as a bearer token. Both resolve to a tenant
before any query runs, and neither is trusted past that point — the tenant id
goes into `withTenant` and Row Level Security does the enforcing.

Choices worth knowing:

**Opaque session tokens, not JWTs.** A JWT cannot be revoked before it expires
without the server-side list that a session table already is, and it adds
signing keys and algorithm confusion to the threat model in exchange for a
lookup this system performs anyway. Only the hash is stored, so a database leak
yields no usable session.

**scrypt for passwords**, N=65536 — argon2id is the first recommendation and
this is the second, chosen because it ships in Node's standard library and the
runtime image needs no native build. The encoding carries its own algorithm
name, so a future hash can be a different one without a migration.

**An unknown address and a wrong password are indistinguishable**, in the
response *and* the timing: a missing account is still verified against a dummy
hash. For a tax product, an enumeration oracle tells an attacker which companies
are customers.

**MFA is mandatory for owner and accountant** (§ 10.3), and enrolment completes
on the first sign-in — setup issues the secret but cannot confirm it, and an
account its owner cannot use is not a security feature. A used time step is
claimed atomically, so a code relayed by a phishing page inside its 30-second
window is already spent.

Lookups go through `SECURITY DEFINER` functions, because authentication is the
step that establishes the tenant scope — there is no scope to look it up under.

### Password reset

The path from "controls an inbox" to "controls the account", so it has to keep
every property the login flow establishes:

- **One answer for every address.** Requesting a reset returns the same body and
  comparable timing whether or not the account exists. This endpoint is
  unauthenticated and cheap to script, so a difference here enumerates the
  customer list faster than login ever could.
- **The second factor still applies.** Any account with a TOTP secret — or a
  role that requires one — must present a code. Otherwise reset *is* the MFA
  bypass, and control of a mailbox would be enough to take an owner account.
- **One link, once.** The token is claimed atomically, a new request invalidates
  the previous link, and unknown, expired and already-used are one answer.
- **A wrong code does not spend the link.** The token is read before it is
  claimed, so six mistyped digits do not cost the user their one chance.
- **Every session is revoked.** People reset passwords when they believe someone
  else has their account; leaving that person signed in would defeat it.

The link is a credential in a URL, so the layout sets `referrer: no-referrer` —
otherwise it rides along in the `Referer` of every font request the page makes.

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

- `docker-compose.yml` has not been brought up. The database suite was verified
  against a throwaway PostgreSQL 16 cluster instead, and runs in CI against a
  service container.
- Every version in `services/mustang-svc/versions.properties` reads `UNPINNED`.
  Pinning them against a resolved build is F1 week 1 and blocks storing any
  verdict (R-2).
- **The Verfahrensdokumentation renders to HTML, not PDF/A.** The page is
  print-ready and carries no external asset, but the conversion to PDF/A-3 and
  the archiving of the fassung under Object Lock are not wired. Until they are,
  the fassung is retained in PostgreSQL only.
- **The DATEV column list is transcribed, not checked.** `packages/datev`
  writes 124 captions on the second header line, and DATEV matches each row's
  width against that line. The surrounding structure is right — two header
  lines, semicolons, CRLF, Windows-1252, DDMM — but the caption list and its
  count have not been diffed against DATEV's own Buchungsstapel v13 layout.
  Do that before the first real import. A Steuerberater's test import is
  already on the F1 critical path for this reason.
