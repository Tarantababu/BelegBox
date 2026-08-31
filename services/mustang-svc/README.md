# mustang-svc

L1 (XSD) and L2 (KoSIT Schematron) live here, in one JVM, because both
validators are JVM-native and the KoSIT configuration must be pinned in exactly
one place.

## Wire contract

```
GET  /health
  -> 200 {"status":"ok","validatorConfigVersion":"…","mustangVersion":"…"}

POST /validate
  X-Belegbox-Filename: invoice.xml
  body: the raw document bytes, unmodified
  -> 200 {
       "validatorConfigVersion": "…",
       "mustangVersion": "…",
       "l1": { "ran": true, "valid": true },
       "l2": { "ran": false, "valid": false, "skippedReason": "…" },
       "findings": [ { "layer": "l1_schema", "code": "…",
                       "severity": "error", "btRef": "…", "message": "…" } ]
     }
```

The body is raw bytes rather than base64-in-JSON for two reasons: the archived
document must never be re-serialised on the way through, and it keeps JSON
parsing out of the Java service entirely.

`message` is the validator's own output, stored verbatim. The product shows it
next to the plain-language explanation — that transparency is a feature, not a
debug affordance.

## State of this service

| Layer | Status |
|---|---|
| L1 XSD | Implemented against the JDK's `javax.xml.validation`. Reports `ran: false` until the schemas are vendored into `schemas/`. |
| L2 Schematron | **Not wired.** Returns `ran: false` with a reason. |

Wiring L2 is F1 week 2-3 and is where `de.kosit:validationtool` and
`org.mustangproject:library` enter `pom.xml`. Both version numbers in
`versions.properties` are placeholders and must be resolved against a real
build before anything is pinned.

## Vendoring the schemas

Not committed — they are large and separately licensed. `schemas/` needs:

```
schemas/ubl/maindoc/UBL-Invoice-2.1.xsd     (+ common/)
schemas/ubl/maindoc/UBL-CreditNote-2.1.xsd
schemas/cii/CrossIndustryInvoice_100pD16B.xsd
```

Fetch them with a pinned script in F1 week 1 and record the checksums beside
the validator configuration hash.

## Local build

Needs a JDK 21 and Maven, neither of which is installed on the machine this was
scaffolded on — this service has **not been compiled yet**.

```bash
cd services/mustang-svc && mvn package && java -jar target/mustang-svc.jar
```

Or through Docker, which is how the rest of the stack talks to it:

```bash
pnpm svc:up
```
