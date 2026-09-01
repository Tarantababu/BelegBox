#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseInvoice } from "@belegbox/core-invoice";
import {
  Db,
  archiveDocument,
  createPool,
  insertDocument,
  insertFindings,
  migrate,
  sealArchiveDay,
} from "@belegbox/db";
import { generateTotpSecret, hashPassword, totpCode } from "@belegbox/auth";
import { createUser } from "@belegbox/db";
import { generateInboxAddress } from "@belegbox/ingest";
import { loadRuleSet } from "@belegbox/rules-engine";
import { validateDocument } from "@belegbox/validation";
import { createTenant } from "@belegbox/db";

/**
 * Development seed.
 *
 * Runs the corpus through the real pipeline rather than inserting canned rows,
 * so what the screens show is what the engine actually produced. A fixture that
 * bypasses the code it is meant to demonstrate is how a UI ends up rendering a
 * verdict the backend never reaches.
 */

const ROOT = join(import.meta.dirname, "../../..");

const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("DATABASE_URL is required.");
  process.exit(2);
}

const db = new Db(createPool(url, 4));

try {
  await db.withAdmin(async (client) => {
    await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'belegbox_app') THEN
          CREATE ROLE belegbox_app LOGIN PASSWORD 'belegbox';
        END IF;
      END $$;
    `);
    await client.query("GRANT USAGE ON SCHEMA public TO belegbox_app");
    const { applied } = await migrate(client);
    if (applied.length > 0) console.log(`migrations applied: ${applied.join(", ")}`);
  });

  const address = generateInboxAddress("Şahin Döner GmbH", "belegbox.de", "a7f31c9d");
  const created = await db.withAdmin((client) =>
    createTenant(client, {
      name: "Şahin Döner GmbH",
      slug: address.slug,
      inboxAddress: address.address,
      inboxSuffix: address.suffix,
      vatId: "DE100000099",
      industry: "gastro-de",
      locale: "tr",
    }),
  );
  const tenantId = created.tenant.id;

  // An owner with a known password and a known second factor, so the sign-in
  // flow can actually be exercised in development.
  const seedEmail = "mehmet@sahin-doener.example";
  const seedPassword = "belegbox-dev-password";
  const seedSecret = generateTotpSecret();
  const seedPasswordHash = await hashPassword(seedPassword);
  await db.withTenant(tenantId, (tx) =>
    createUser(tx, {
      email: seedEmail,
      role: "owner",
      passwordHash: seedPasswordHash,
      locale: "tr",
      totpSecret: seedSecret,
      mfaEnabled: false,
    }),
  );

  const ruleSet = loadRuleSet(await readFile(join(ROOT, "rulesets/gastro-de.yaml"), "utf8"));
  const corpusDir = join(ROOT, "corpus");
  const files = (await readdir(corpusDir)).filter((f) => f.endsWith(".xml")).sort();

  let documents = 0;
  let findings = 0;

  for (const [index, file] of files.entries()) {
    const bytes = await readFile(join(corpusDir, file));

    // skipL1L2: mustang-svc needs a JVM. The form verdict stays "unknown"
    // rather than being invented, which is exactly what the screen must show
    // when the validator is unavailable.
    const result = await validateDocument({ filename: file, bytes }, { skipL1L2: true, ruleSet });

    let invoice;
    try {
      invoice = parseInvoice(bytes);
    } catch {
      invoice = undefined;
    }

    await db.withTenant(tenantId, async (tx) => {
      const { id } = await insertDocument(tx, {
        inboxId: created.inboxId,
        sourceChannel: "email",
        rawObjectKey: `seed/${file}`,
        rawSha256: createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: bytes.length,
        filename: file,
        contentType: "application/xml",
        format: result.detection.format,
        profileUrn: result.detection.profile.urn,
        status: result.status,
        verdictForm: result.verdict.form,
        verdictContent: result.verdict.content,
        docTypeCode: result.detection.documentTypeCode ?? null,
        senderAuth: { spf: "pass", dkim: "pass", dmarc: "pass" },
        issuedAt: invoice?.issueDate ?? null,
        dueAt: invoice?.dueDate ?? null,
        // Spread across recent days so the inbox has a plausible shape.
        receivedAt: new Date(Date.now() - index * 36e5 * 6).toISOString(),
        supplierName: invoice?.seller.name ?? null,
        supplierVatId: invoice?.seller.vatId ?? null,
        invoiceNumber: invoice?.invoiceNumber ?? null,
        totalGross: invoice?.totals.taxInclusive ?? null,
        totalNet: invoice?.totals.taxExclusive ?? null,
        totalVat: invoice?.totals.taxTotal ?? null,
        parsed: invoice ?? null,
      });
      documents += 1;

      findings += await insertFindings(
        tx,
        result.findings.map((f) => ({
          documentId: id,
          layer: f.layer,
          code: f.code,
          severity: f.severity,
          btRef: f.btRef ?? null,
          legalBasis: f.legalBasis ?? null,
          messageRaw: f.messageRaw,
          explainKey: f.explainKey ?? null,
          params: f.params ?? null,
          validatorConfigVersion: f.versions.validatorConfigVersion,
          engineVersion: f.versions.engineVersion,
          rulesetVersion: f.versions.rulesetVersion ?? null,
        })),
      );

      // Archive and seal one older day, so the proof endpoint has something to
      // prove and the chain is not empty on a fresh database.
      if (index >= files.length - 2) {
        await archiveDocument(tx, id, { archivedAt: new Date("2026-08-01T09:00:00Z") });
      }
    });
  }

  await db.withTenant(tenantId, (tx) => sealArchiveDay(tx, "2026-08-01"));

  console.log(`tenant     ${tenantId}`);
  console.log(`inbox      ${created.inboxAddress}`);
  console.log(`documents  ${documents}`);
  console.log(`findings   ${findings}`);
  console.log("");
  console.log(`sign in   ${seedEmail} / ${seedPassword}`);
  console.log(`totp      ${seedSecret}`);
  console.log(`code now  ${totpCode(seedSecret, Math.floor(Date.now() / 1000 / 30))}`);
} finally {
  await db.close();
}
