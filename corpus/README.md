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

## Still to vendor (F1 week 1)

The hand-authored set is deliberate but small, and it is not a substitute for
the official suites. Vendor these into `corpus/vendor/` (git-ignored, fetched by
a pinned script) before trusting any snapshot:

- KoSIT `validator-configuration-xrechnung` test suite — pinned to the same
  release tag the validator runs, recorded in
  `services/mustang-svc/versions.properties`
- XRechnung Schematron test set (positive and negative cases per business rule)
- Mustangproject sample files, for ZUGFeRD profile coverage across all six
  profiles
- The VGSD collection named in the plan's pre-launch checklist

Target from PRD §8.5 is 40+ samples, one per error type, published later as the
BB-API integration accelerator. Growing this directory is therefore product
work, not test hygiene.
