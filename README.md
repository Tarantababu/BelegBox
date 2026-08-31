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
| `packages/db` | **Sprint 0.** Extensions and the app role. Tables and RLS are week 2 |
| `corpus` | **Sprint 0.** Seven hand-authored fixtures with committed snapshots |
| `apps/api` | Week 1-2. Fastify, `/v1`, the only write path |
| `apps/worker` | Week 1. Ingest, validate, notify consumers |
| `apps/web` | Week 4-5. Next.js, consumes `/v1` |
| `packages/rules-engine` | Week 3-4. YAML → AST → evaluator |
| `packages/explain` | Week 4-5. Versioned templates, DE + TR |
| `packages/payments` | Week 5-6. EPC-QR, pain.001 |
| `packages/datev` | Week 5-6. EXTF writer |
| `packages/archive` | Week 2. WORM writer, Merkle day-chain |
| `apps/mobile` | F3 |

## Two invariants

**The form verdict comes from L1 and L2 alone.** L3 and L4 cannot touch it. The
`TenantSeverity` type excludes `form_error`, so a tenant-authored rule that
tries to produce one does not compile.

**Rules are selected by the document's issue date (BT-2), never by `now()`.** A
2025 invoice is judged by the 2025 rules — otherwise the archive re-judges
itself every time the law changes.

## What is not verified yet

Scaffolded on a machine with no JDK and no Docker, so:

- `services/mustang-svc` has **not been compiled or run**. The CI `jvm` job
  builds it, boots it and probes `/health`; that is the first real check.
- `docker-compose.yml` has not been brought up.
- Every version in `services/mustang-svc/versions.properties` reads `UNPINNED`.
  Pinning them against a resolved build is F1 week 1 and blocks storing any
  verdict (R-2).
