# Belegbox — Implementation Plan

**Input:** PRD v1.0 (31.08.2026) + clickable prototype v2 (`Belegbox Prototype V2 - Fintech Startup.html`)
**Status:** greenfield — `/Users/halinur/BelegBox` is empty
**Audience:** the implementing engineer (solo founder + AI assistance)

---

## 0. Summary of the call

The PRD is unusually good: the regulatory base is correct, the moat (L3 content validation + ZUGFeRD profile check + fraud signals + multilingual explanation) is real and absent from competitors, and the licence boundaries (ZAG / StBerG / RDG / KWG) are drawn before code exists. The plan below does not re-litigate strategy. It resolves the contradictions between the PRD and the prototype, fixes what the prototype gets factually wrong, and turns F1 into a week-by-week build.

**Four decisions that change the build:**

| # | Decision | Why |
|---|---|---|
| D1 | **Build the YAML rule engine in F1, ship the no-code builder UI in F3** | PRD §6.1 says "sector difference is data, not code" but puts M-09 in v2/F3. In MVP that makes the thesis false — L3/L4 would be hardcoded. The interpreter is ~2 days of work; the *builder UI* is the expensive part. Split them. |
| D2 | **F1 ships two rulesets: `handwerk-bau-de` (primary) + `gastro-de` (demo)** | Roadmap F1 says Handwerk (higher willingness to pay, BC-02); the prototype demos Gastro (BC-01). With D1 in place the second ruleset is YAML, not code. Keep the gastro demo — it is the existing sales asset. |
| D3 | **No LLM at request time in F1. Explanations are versioned templates + ICU interpolation** | PRD §5.4 already demands human-approved templates. Going one step further (LLM only at authoring time) removes the hallucination risk, removes an AVV subprocessor, removes the €0.30/user/month line, and makes verdicts byte-reproducible for an audit in 2033. |
| D4 | **TypeScript/Node everywhere + one Java sidecar** | PRD §9.2 leaves "TS or Python" open. Pick TS: same language for API, web (Next.js), workers and React Native. Java sidecar (`mustang-svc`) hosts *both* Mustangproject and the KoSIT validator in one JVM. |

---

## 1. Analysis — what must be fixed before it is coded

### 1.1 Prototype defects that must not be ported

The prototype is a demo, not a foundation. These are the items where the prototype currently states something **incorrect**, not merely simplified:

| ID | Location | Problem | Fix |
|---|---|---|---|
| P-1 | `qrSvg()` | Not a QR code. Deterministic pseudo-random module pattern with three finder squares. It will not scan. | Real encoder, **ECC level M**, EPC-069-12 payload ≤331 bytes, charset code 1 (UTF-8). |
| P-2 | `epc()` | 11 elements emitted. EPC-069-12 defines 12 (ServiceTag, Version, CharSet, Identification, BIC, Name, IBAN, Amount, Purpose, Structured ref, Unstructured text, Information). Name is not truncated to 70 chars. | Rewrite against the spec; unit-test with a scanning bank app. Structured **or** unstructured remittance, never both. |
| P-3 | `csvPanel()` | `Umsatz;SollHaben;Datum;Konto;Gegenkonto` is not DATEV. DATEV **EXTF** requires a metadata header line + a column header line (31+ columns), Berater-/Mandantennummer, fiscal year start, account length, quoting rules — and `Datum` is `DDMM` within the fiscal year, not `28082026`. This file would be rejected on import. | Dedicated `packages/datev`, validated against a real DATEV import (ask the pilot's Steuerberater to test-import). |
| P-4 | Invoice #2 explanation text | Claims a **47,64 €** VAT gap. Gross-constant reclassification to 19 % gives 40,38 €; net-constant gives 48,04 € (= `net × 0.12`, matching the ruleset YAML in §6.3). 47,64 € reconciles to neither. | Pick one doctrine — **net-constant** (`gap = net × (0.19 − 0.07)`) — write it into the explain template, and show the assumption in the UI. Never print a number the user cannot reproduce. |
| P-5 | All explanation strings | Violate the product's own StBerG frame (§13.2). "doğrusu %19", "denetimde sana geri döner" is an assessment of *the user's* tax position. There is no "confirm with your Steuerberater" anywhere. | Explain template schema gets **mandatory slots**: `observation` (what the document says) + `legal_basis` (statute) + `disclaimer` (non-removable). Renderer refuses to emit a template missing them. |
| P-6 | `esc()` | Escapes `& < > "` but not `'`. Values flow into `onclick="toast('${esc(name)}')"` — a supplier named `O'Brien GmbH` breaks out of the JS string. | Not portable at all: rebuild in React. No string-concatenated HTML in production. |
| P-7 | Inbox stat | "Bu ay gelen" renders `inv.length` (5) including archived docs, while the archive stat counts them again. | Define the stat semantics once in the API, not in the view. |
| P-8 | Wizard "Kendim gireceğim" | Hardcodes `setPct(25)`; the pill highlights whenever `pct !== 30`. Caret jumps in `#wp` on every keystroke. | Rebuild as controlled form state. |

Verified as **correct** in the prototype (keep the behaviour): the gastro split math (1.200 € → 840/360 → 112,43 € VAT; 33,93 € under-declaration if all at 7 %) and the BR-CO-15 case on invoice #3 (262,56 + 49,89 = 312,45 vs 316,65 declared → 4,20 € difference).

### 1.2 Gaps in the PRD

Requirements that are load-bearing and not in the document:

- **R-1 · Time-versioned rules.** A 2025 invoice must be judged by the 2025 rule set. The YAML has `version` but no `effective_from` / `effective_to`, and no statement that evaluation keys off `BT-2` (issue date) rather than `now()`. Without this, the 7 %/19 % gastro rule mis-judges every pre-2026 document in the archive.
- **R-2 · Verdict reproducibility.** Every `finding` must persist `validator_config_version` (the pinned KoSIT `validator-configuration-xrechnung` release), `ruleset_version`, and `engine_version`. In an audit in 2033 you must be able to re-derive a 2026 verdict. Pin the KoSIT configuration; upgrading it is a deliberate, logged event.
- **R-3 · Correction/cancellation chain.** UNTDID 1001 `384` (corrected) and `381` (credit note) need a link to the original document and a sign convention. Today a corrected invoice arrives as an unrelated row.
- **R-4 · Gapless outgoing numbering** (Nummernkreis) with a per-tenant sequence and gap detection — GoBD *Vollständigkeit*, and it blocks M-08.
- **R-5 · Transmission evidence.** For outgoing invoices, keep the SMTP message-id, timestamp and recipient as evidence of dispatch. Handwerk customers will need it in payment disputes.
- **R-6 · Exit / wind-down policy.** Ten-year retention sold by a one-person company. Steuerberater *will* ask. Answer: quarterly full export (raw XML + manifest + hash chain) pushed to the tenant's own storage, plus a published wind-down procedure. Cheap to build, disproportionate in sales.
- **R-7 · Erasure vs retention.** §10.1 flags the conflict but not the resolution. Position: Art. 17(3)(b) DSGVO — legal retention overrides erasure; per-tenant KMS key destruction is *not* offered because it would destroy records the tenant is required to keep. Say this in the UI and in the AVV.

### 1.3 Architecture risks worth pricing now

- **S3 Object Lock Compliance mode is irreversible.** A bug that writes a 10-year lock on test data costs money for a decade. Use *Governance* mode in dev/staging, *Compliance* only in prod, separate buckets per retention class, and a documented pre-flight test (Ek A already lists it).
- **RLS + connection pooler.** Tenant isolation via `SET LOCAL app.tenant_id` inside the transaction. With PgBouncer in transaction mode, a bare `SET` leaks across pooled connections. This must be a lint rule, not a convention.
- **The inbound mailbox is the real attack surface.** Address = `{slug}-{random8}@belegbox.de`. Record SPF/DKIM/DMARC result per message, store it on the document, surface it in the UI, and feed it into D-008. A forged invoice with a swapped IBAN is the loss event that kills a customer.
- **`pain.001.001.09` alone is not enough.** Many German online-banking portals still accept only `pain.001.001.03`. Emit both and let the user choose.

---

## 2. Scope — F1 (MVP)

**In:** M-01 Setup · M-02 Inbox · M-03 Document detail (dual verdict) · M-04 Payment preparation · M-05 GoBD archive · M-06 DATEV export · M-11 Verfahrensdokumentation · rule engine core (D1) · two rulesets (D2) · explain templates de+tr (D3).

M-11 is pulled forward from F2: it renders the tenant's own configuration to PDF, it is a free lead magnet, and it costs ~2 days once the config model exists.

**Out of F1, explicitly:** OCR (M-07), outgoing invoices (M-08), no-code rule builder UI (M-09), mobile, public API surface, Kanzlei portal, Peppol, everything in M-12…M-25.

**API-first is not a phase.** Per PRD §4 the web app is the first customer of `/v1`. F4 is *publishing, documenting and SDK-ing* the API — not building it.

---

## 3. Technical foundation

### 3.1 Stack

| Layer | Choice |
|---|---|
| API | TypeScript + Fastify, OpenAPI 3.1 generated from Zod schemas |
| Web | Next.js (App Router), server components, no client state library |
| Workers | Same Node image, pgmq consumers |
| E-invoice core | `mustang-svc` — one JVM container, Spring Boot minimal, hosting **Mustangproject** (parse/generate ZUGFeRD 2.5 + CII) **and** the **KoSIT validator** (pinned configuration) |
| Rule engine | Own YAML→AST interpreter (JSONLogic-style), in `packages/rules-engine` |
| DB | PostgreSQL 16, JSONB for BT fields, `pg_trgm` full text, RLS |
| Queue | pgmq |
| Object store | S3-compatible + Object Lock (Compliance), eu-central |
| Hosting | Hetzner (Nürnberg/Falkenstein) |
| Billing | Paddle (Merchant of Record) |
| Observability | OpenTelemetry → Grafana Cloud, Sentry |

### 3.2 Repository layout

```
belegbox/
  apps/
    api/            Fastify, /v1 — the only write path
    web/            Next.js, consumes /v1
    worker/         ingest + validate + notify consumers
    mobile/         Expo (F3)
  services/
    mustang-svc/    Java: Mustangproject + KoSIT validator, HTTP
  packages/
    core-invoice/   BT/BG model, normalizers, format+profile detection
    rules-engine/   YAML parser, AST, evaluator, dry-run harness
    explain/        template registry, ICU messages, de/tr locales
    datev/          EXTF writer
    payments/       EPC-QR encoder, pain.001 (.03 + .09)
    archive/        WORM writer, SHA-256, Merkle day-chain
    db/             migrations, RLS policies, typed client
  rulesets/         gastro-de.yaml, handwerk-bau-de.yaml, ...
  corpus/           valid + deliberately broken sample invoices
  infra/            terraform + ansible
```

### 3.3 Data model deltas vs PRD §9.4

Additions on top of the PRD schema:

```sql
-- reproducibility (R-2)
ALTER TABLE findings ADD COLUMN validator_config_version text NOT NULL;
ALTER TABLE findings ADD COLUMN ruleset_version        int;
ALTER TABLE findings ADD COLUMN engine_version         text NOT NULL;

-- time-versioned rules (R-1)
--   rule evaluation keys off documents.issued_at (BT-2)
ALTER TABLE rulesets ADD COLUMN effective_from date NOT NULL;
ALTER TABLE rulesets ADD COLUMN effective_to   date;

-- correction chain (R-3)
ALTER TABLE documents ADD COLUMN doc_type_code text;        -- UNTDID 1001
ALTER TABLE documents ADD COLUMN corrects_document_id uuid REFERENCES documents(id);

-- email channel forensics (§10.3)
ALTER TABLE documents ADD COLUMN sender_auth jsonb;         -- spf/dkim/dmarc + envelope
ALTER TABLE documents ADD COLUMN message_id text;

-- outgoing numbering (R-4) and dispatch evidence (R-5)
CREATE TABLE number_ranges(tenant_id uuid, key text, next_value bigint, PRIMARY KEY(tenant_id,key));
CREATE TABLE dispatches(id uuid PRIMARY KEY, document_id uuid, channel text,
                        recipient text, smtp_message_id text, sent_at timestamptz);
```

`audit_log` and `archive_chain` get no `UPDATE`/`DELETE` grant for any application role — enforced by migration, not by discipline.

### 3.4 Validation pipeline

```
ingest → L1 XSD → L2 KoSIT/Schematron → L3 domain → L4 tenant → explain → archive → notify
          │            │                   │           │
          └─ fail ⇒ verdict_form = fail, pipeline stops at L2 boundary
                                          └───────────┴─ may only emit content_error | warning | info
```

Hard rules encoded in the type system, not in review comments:

1. `verdict_form` is derived **only** from L1+L2. L3/L4 cannot touch it. `RuleAction` at L4 parses to a severity union that excludes `form_error`.
2. Rules are selected by `documents.issued_at ∈ [effective_from, effective_to)`.
3. Every finding carries `code`, `layer`, `bt_ref`, `legal_basis`, `explain_key`, `params`, plus the three version columns from R-2.
4. Raw Schematron output is stored verbatim (`message_raw`) and shown in the UI next to the human explanation — that transparency is a differentiator, not a debug feature.

**L3 rules D-001…D-009** are implemented as first-class code (not YAML) because they are the moat and need real logic: ZUGFeRD profile URN check, missing exemption reason for `AE/E/K/G/Z`, Leitweg-ID presence+format for B2G, VIES lookup, rate/category consistency, due-before-issue, duplicate `(supplier_vat_id, BT-1)`, IBAN-country vs VAT-ID-country mismatch, and >300 % deviation from the supplier's 12-month mean.

D-004 (VIES) and D-009 (statistical) need care: VIES is flaky — cache results 24 h and degrade to `warning` on service outage, never to `content_error`. D-009 needs ≥6 prior invoices from that supplier before it may fire.

### 3.5 Explain system (D3)

```
explain/
  templates/gastro.beverage_wrong_rate.yaml
    version: 2
    slots: { observation, legal_basis, disclaimer }   # all three required
    locales: { de: ..., tr: ... }
    params: [line_description, declared_rate, expected_rate, vat_gap]
```

Renderer contract: pure function `(explain_key, locale, params) → { observation, legal_basis, disclaimer }`. No network call. A template that omits `disclaimer` fails the build. Every string is reviewed by the lawyer (Ek A) before it can be marked `approved: true`; unapproved templates render only in dev.

---

## 4. Work breakdown

### Sprint 0 — one week

Walking skeleton, end to end, before any feature work.

- Monorepo (pnpm + Turborepo), CI, lint, typecheck, Docker Compose (Postgres, MinIO, mustang-svc).
- `mustang-svc` container: Mustangproject + KoSIT validator, configuration version **pinned** and printed at boot.
- `corpus/` seeded from the KoSIT/XRechnung test suite + Mustang samples; a CLI that runs every corpus file through L1+L2 and snapshots the output.
- Hetzner project, Postgres, S3 bucket with Object Lock in Governance mode; one prod bucket in Compliance mode created and *proved* undeletable (Ek A item).
- **Done when:** `pnpm validate corpus/xrechnung-ubl-valid-01.xml` prints a KoSIT verdict, on CI, from a pinned config.

### F1 — 8 weeks

| Week | Deliverable | Done when |
|---|---|---|
| 1 | Ingest: inbound MX webhook (Postmark/Mailgun) → MIME parse → attachment extraction → format detection → **ZUGFeRD profile URN** → SHA-256 dedup → raw to WORM. Sender auth captured. | A real XRechnung and a real ZUGFeRD PDF/A-3 mailed to a test address land as `documents` rows with correct `format` and `profile_urn`; a `MINIMUM` profile is classified `not_einvoice`. |
| 2 | Tenants, users, RLS, `SET LOCAL` discipline + a test that proves cross-tenant reads fail. Archive writer: hash + daily Merkle chain + proof endpoint. | Integration test: tenant B cannot read tenant A's document by id. `GET /v1/archive/proof/{id}` verifies. |
| 2–3 | L1 + L2 wired to the pipeline, findings normalized, `verdict_form` set, raw Schematron persisted. | Every corpus file produces a stable, snapshot-tested verdict. |
| 3–4 | `packages/rules-engine`: YAML → AST → evaluator; operators `equals/not_equals/gt/lt/between/in/matches_regex/matches_lexicon/is_empty/vies_valid`; actions `flag/compute/tag/require_field/notify`. L3 D-001…D-009. `handwerk-bau-de` + `gastro-de`. Dry-run harness against the corpus. | Invoice #2 from the prototype (Getränke Müller, 428,40 €) fires `gastro-beverage-rate` with `vat_gap = 48,04 €` and cites § 12 Abs. 2 Nr. 15 UStG. Invoice #3 fires BR-CO-15 at L2 with a 4,20 € difference. |
| 4–5 | Explain templates (de+tr) for every L2 code in the corpus and every L3 code. M-01 setup (<90 s, 3 fields, no card). M-02 inbox. M-03 detail with dual verdict, raw output, human explanation, disclaimer. | A pilot user completes setup in under 90 s and can explain invoice #2 to their supplier from the screen alone. |
| 5–6 | M-04: real EPC-QR (P-1, P-2) + `pain.001.001.03` and `.09`. M-06: DATEV EXTF (P-3) + original documents ZIP. M-05: archive search (`pg_trgm`). | A GiroCode scans in a real banking app. A Steuerberater successfully imports the EXTF file into DATEV. |
| 6–7 | M-11 Verfahrensdokumentation PDF from tenant config. Paddle billing + plans. AVV click-through + TOM annex. Legal review handoff (all templates + AGB + AVV). | Verfahrensdokumentation generated for a real tenant; lawyer's review is in progress, not queued. |
| 7–8 | Hardening: rate limits, secrets in Vault/SOPS, MFA for owner/accountant, OTel dashboards, backup/restore drill, R-6 quarterly export. Onboard 3 paying pilots. | Restore-from-backup drill passes. Three pilots are live and paying. |

**F1 exit gate (PRD §13.4):** 3 paying pilots. If zero → switch segment to the Kanzlei channel before writing more code.

### F2 — 10 weeks

M-07 OCR (cloud vision LLM + `pdfplumber`/Tesseract pre-pass, server-side only), rulesets 3 and 4 (`logistik-de`, `freiberuf-de`), M-24 free tools + M-25 unregistered flow — **published in TR/PL/RO first** (§B.4: the German SEO channel is saturated, the Turkish one is empty). Target: 25 paying customers.

### F3 — 12 weeks

BB-MOBILE (Expo, capture/approve/notify only), M-08 outgoing invoices (with R-4 numbering and R-5 dispatch evidence), M-09 rule builder levels 2 and 3, M-15/16/17/18. Rule save is gated on the 90-day dry-run preview from PRD §6.4 — that is the single most important safety mechanism in the rule feature.

### F4 — 10 weeks

Publish `/v1`: OpenAPI 3.1, `sk_live_`/`sk_test_` key-typed environments (no separate sandbox URL), `Idempotency-Key` on all writes, webhooks with HMAC-SHA256 + replay protection + the 1m/5m/30m/2h/12h/24h retry ladder, SDKs (TS, PHP, Python, Java), and the 40+ sample corpus published as the integration accelerator.

### F5 — 8 weeks

BB-KANZLEI multi-tenant portal, ruleset distribution across mandants, per-mandant billing tiers.

---

## 5. Test strategy

- **Golden corpus, snapshot-tested.** Every sample invoice has a committed expected verdict. A KoSIT configuration bump is a PR that shows exactly which verdicts moved.
- **Rule dry-run as a first-class tool.** The same harness that powers §6.4's "this rule would have flagged 7 documents" runs in CI against the corpus.
- **Property tests on money.** Rounding: split-then-round vs round-then-split must be pinned. Assert `sum(line net) + sum(vat) == gross` to the cent for every generated invoice.
- **Adversarial ingest corpus.** Forged sender, swapped IBAN, ZIP bombs, 60 MB attachments, malformed MIME, XML with external entities (XXE — disable DTD loading in *both* Node and the JVM), duplicate resend.
- **Manual acceptance:** a real banking app must scan the GiroCode; a real DATEV instance must import the EXTF file. Neither can be unit-tested.

---

## 6. Parallel legal/ops track — launch gates

These are blocking, not background:

| Gate | Owner | Blocks |
|---|---|---|
| Lawyer review of every explain template + AGB + AVV (StBerG frame, §13.2) | external, €1–2k | Public launch |
| Steuerberater advisory relationship | founder | F1 pilots (also the DATEV import test) |
| LLM provider: EU region + zero data retention, listed in AVV | founder | F2 (OCR); F1 needs no LLM at runtime by D3 |
| Object Lock Compliance proof-of-undeletability | eng | Any prod archive write |
| KoSIT configuration version pinned and recorded | eng | Any stored verdict (R-2) |
| Gewerbeanmeldung / residence-permit check | founder | Invoicing customers |

---

## 7. Open decisions

1. **Primary F1 sector.** Plan assumes Handwerk primary + Gastro demo (D2). If the first three pilots are gastronomy, flip the primary — the code does not change, only which ruleset is battle-tested first.
2. **Inbound mail provider.** Postmark (cleaner inbound parsing) vs Mailgun (larger attachment ceiling). Decide in week 1; both are behind one `IngestSource` interface.
3. **Competitor teardown from §B.2** — is the rival's "Abschlags-/Schlussrechnung" a real feature or a landing page? Answer changes M-08's size in F3, nothing before it.
4. **VAT-gap doctrine (P-4)** — net-constant is assumed here. Confirm with the Steuerberater; it is a one-line change and a template edit.
