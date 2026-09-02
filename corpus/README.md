# Corpus

Every fixture here has a committed expected verdict. A KoSIT configuration bump
then arrives as a pull request that shows exactly which verdicts moved — that is
the whole point of the corpus, and requirement R-2 (verdict reproducibility)
depends on it.

## Provenance

**All data in this directory is synthetic.** Company names echo the personas in
the PRD business cases; VAT IDs are sequential placeholders (`DE1000000xx`),
email domains carry `-beispiel`, and IBANs are the published test IBANs already
used in the prototype. Nothing here belongs to a real business.

## Hand-authored fixtures

| File | Syntax | Expected form | Expected content | Exercises |
|---|---|---|---|---|
| `xrechnung-ubl-valid-01.xml` | UBL | pass | pass | Baseline. 487.39 + 92.60 = 579.99 |
| `xrechnung-cii-valid-01.xml` | CII | pass | pass | Same CIUS, other syntax. 654.21 @ 7 % |
| `zugferd-en16931-01.xml` | CII | pass | pass | EN 16931 / COMFORT profile is a real e-invoice |
| `zugferd-minimum-01.xml` | CII | n/a | n/a | **D-001** — MINIMUM is not an e-invoice |
| `broken-br-co-15-01.xml` | UBL | **fail** | not evaluated | BR-CO-15, 4.20 € discrepancy |
| `gastro-beverage-7pct-01.xml` | UBL | pass | **fail** | **The differentiator.** Beverages at 7 %, gap 48.04 € |
| `missing-exemption-reason-ae-01.xml` | UBL | fail | — | **D-002** — category `AE` with no BT-120/121 |

`broken-br-co-15-01.xml` stops at the L2 boundary: the form verdict is fail and
no content verdict is produced. `gastro-beverage-7pct-01.xml` is the inverse and
is the fixture the product exists for — every competing validator passes it.

## Vendored suites

### ZUGFeRD corpus

The official collection at [ZUGFeRD/corpus](https://github.com/ZUGFeRD/corpus) —
239 files: every ZUGFeRD profile across v1 and v2, XRechnung in CII, UBL and
Factur-X, Peppol BIS, fatturaPA, and one scanned PDF with nothing inside it.

```
scripts/fetch-zugferd-corpus.sh
```

Pinned to a commit and **not committed** — ~170 MB, `corpus/vendor/` is
git-ignored, and `packages/validation/src/zugferd-corpus.test.ts` skips when it
is absent. The pin is what makes the snapshot meaningful: if the fixtures could
move underneath it, a changed verdict would be ambiguous between their change
and ours.

What the suite asserts is deliberately not "everything validates". Most of these
documents are not supposed to pass and several are not e-invoices at all. It
asserts that **every file gets a considered answer** — detected with a named
profile, or refused with a reason that has an explanation template behind it.
Never an unexplained throw, never a silent misclassification.

Running it the first time found four defects that our own fixtures could not
have, because our fixtures were written by the same hands as the parser:

| Defect | Effect |
|---|---|
| `/Length 200 0 R` read as a byte count | 39 PDFs truncated to a well-formed prefix; extraction reported success |
| `/EF 19 0 R` (indirect) not followed | Real filenames lost, so `isKnownInvoiceName` was always false for ZUGFeRD 1.0 |
| Root element matched without its namespace | ZUGFeRD 1.0 RC `<rsm:Invoice>` parsed as UBL, then rejected for a missing UBL field |
| Profile matched on vendor, not conformance level | **D-001 never fired for `urn:zugferd.de:2p0:*`** — right verdict, no finding, no reason |

The last one is the one worth remembering. The verdict was correct by accident:
an unrecognised profile falls through to `not_einvoice`, which is the same
answer D-001 would have given, so nothing looked wrong. A rule that does not run
and a rule that runs and agrees are indistinguishable from the outside — right
up until the day the profile is `basic` instead of `minimum`, and the fallback
answers `not_einvoice` for a document that is a perfectly good e-invoice.

### Still to vendor

- KoSIT `validator-configuration-xrechnung` test suite — pinned to the same
  release tag the validator runs, recorded in
  `services/mustang-svc/versions.properties`
- XRechnung Schematron test set (positive and negative cases per business rule)
- The VGSD collection named in the plan's pre-launch checklist

Target from PRD §8.5 is 40+ samples, one per error type, published later as the
BB-API integration accelerator. Growing this directory is therefore product
work, not test hygiene.
