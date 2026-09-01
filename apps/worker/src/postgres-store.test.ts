import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Db, createPool, createTenant, listDocuments, getFindings } from "@belegbox/db";
import { generateInboxAddress, ingestMessage, type InboundMessage } from "@belegbox/ingest";
import { loadRuleSet } from "@belegbox/rules-engine";
import { FilesystemObjectStore, S3ObjectStore, type ObjectStore } from "@belegbox/storage";
import { MustangClient } from "@belegbox/validation";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDocumentStore } from "./postgres-store.js";

/**
 * The whole receiving path against real infrastructure: mail in, bytes to the
 * object store, metadata and verdicts into PostgreSQL under the right tenant.
 *
 * Needs a database. Uses whatever S3-compatible store S3_TEST_ENDPOINT points
 * at - MinIO locally - when it is set, and
 * the filesystem otherwise, and the real validator when MUSTANG_SVC_URL is set.
 */
const ADMIN_URL = process.env["DATABASE_URL"];
const suite = ADMIN_URL ? describe : describe.skip;

const ROOT = join(import.meta.dirname, "../../..");
const APP_PASSWORD = "belegbox-test";

let admin: Db;
let app: Db;
let store: PostgresDocumentStore;
let objects: ObjectStore;
let tenantA: string;
let tenantB: string;
let addressA: string;
let addressB: string;

async function objectStore(): Promise<ObjectStore> {
  const endpoint = process.env["S3_TEST_ENDPOINT"];
  if (!endpoint) return new FilesystemObjectStore(await mkdtemp(join(tmpdir(), "bb-objects-")));
  return new S3ObjectStore({
    bucket: process.env["S3_TEST_BUCKET"] ?? "belegbox-raw-dev",
    endpoint,
    // Read from the environment like the endpoint and bucket already are.
    // Hardcoding the MinIO pair meant pointing S3_TEST_ENDPOINT at any other
    // S3-compatible store failed with "Malformed Access Key Id", which reads
    // like a broken store rather than a test that ignored the credentials.
    credentials: {
      accessKeyId: process.env["S3_TEST_ACCESS_KEY"] ?? "belegbox",
      secretAccessKey: process.env["S3_TEST_SECRET_KEY"] ?? "belegbox-dev-secret",
    },
    forcePathStyle: true,
  });
}

async function provision(name: string): Promise<{ id: string; address: string }> {
  const addr = generateInboxAddress(name, "belegbox.de");
  const created = await admin.withAdmin((client) =>
    createTenant(client, {
      name,
      slug: `${addr.slug}-${randomUUID().slice(0, 4)}`,
      inboxAddress: addr.address,
      inboxSuffix: addr.suffix,
      locale: "de",
    }),
  );
  return { id: created.tenant.id, address: created.inboxAddress };
}

beforeAll(async () => {
  if (!ADMIN_URL) return;
  admin = new Db(createPool(ADMIN_URL, 4));

  await admin.withAdmin(async (client) => {
    await client.query(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'belegbox_app') THEN
           CREATE ROLE belegbox_app LOGIN PASSWORD '${APP_PASSWORD}';
         ELSE
           ALTER ROLE belegbox_app LOGIN PASSWORD '${APP_PASSWORD}';
         END IF;
       END $$;`,
    );
  });

  const url = new URL(ADMIN_URL);
  url.username = "belegbox_app";
  url.password = APP_PASSWORD;
  app = new Db(createPool(url.toString(), 6));

  ({ id: tenantA, address: addressA } = await provision("Şahin Döner GmbH"));
  ({ id: tenantB, address: addressB } = await provision("Yılmaz Elektrotechnik GmbH"));

  objects = await objectStore();
  store = new PostgresDocumentStore({
    db: app,
    objects,
    retentionMode: "GOVERNANCE",
    ...(process.env["MUSTANG_SVC_URL"]
      ? { mustang: new MustangClient({ baseUrl: process.env["MUSTANG_SVC_URL"], timeoutMs: 60_000 }) }
      : {}),
    ruleSet: loadRuleSet(await readFile(join(ROOT, "rulesets/gastro-de.yaml"), "utf8")),
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await admin?.close();
});

async function deliver(
  to: string,
  fixture: string,
  messageId = `pm-${randomUUID()}`,
): Promise<InboundMessage> {
  const bytes = await readFile(join(ROOT, "corpus", fixture));
  return {
    provider: "postmark",
    providerMessageId: messageId,
    messageId: `<${messageId}@supplier.de>`,
    to,
    from: "rechnung@lieferant-beispiel.de",
    subject: "Rechnung",
    receivedAt: new Date("2026-08-27T09:14:00Z"),
    senderAuth: { spf: "pass", dkim: "pass", dmarc: "pass" },
    attachments: [{ filename: fixture, contentType: "application/xml", bytes }],
  };
}

suite("postgres document store", () => {
  it("routes a message to its tenant and records the verdict", async () => {
    const message = await deliver(addressA, "gastro-beverage-7pct-01.xml");
    const result = await store.ingest(ingestMessage(message));

    expect(result.accepted).toBe(true);
    expect(result.documents).toHaveLength(1);
    // The content layer runs at ingest, so the document is never visible
    // without a verdict.
    expect(result.documents[0]?.status).toBe("content_error");

    const documents = await app.withTenant(tenantA, (tx) =>
      listDocuments(tx, { search: "GM-88213" }),
    );
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      supplier_name: "Getränke Müller GmbH",
      invoice_number: "GM-88213",
      verdict_content: "fail",
    });

    const findings = await app.withTenant(tenantA, (tx) =>
      getFindings(tx, documents[0]?.id as string),
    );
    const rule = findings.find((f) => f.code === "gastro-beverage-rate");
    expect(rule?.legal_basis).toBe("§ 12 Abs. 2 Nr. 15 UStG");
    expect(rule?.params?.["vat_gap"]).toBe(48.04);
    // R-2: the versions that produced the verdict travel with it.
    expect(rule?.engine_version).toBeTruthy();
  });

  it("keeps one tenant's mail out of another's inbox", async () => {
    await store.ingest(ingestMessage(await deliver(addressB, "xrechnung-ubl-valid-01.xml")));

    const forB = await app.withTenant(tenantB, (tx) => listDocuments(tx, {}));
    const forA = await app.withTenant(tenantA, (tx) => listDocuments(tx, {}));

    expect(forB.map((d) => d.invoice_number)).toContain("SWK-08-2026");
    expect(forA.map((d) => d.invoice_number)).not.toContain("SWK-08-2026");
  });

  /**
   * Every provider redelivers on timeout. The claim is atomic and inside the
   * writing transaction, so this holds even when both deliveries race.
   */
  it("writes one document for a redelivered message", async () => {
    // A fresh id per run: these assertions are about one message delivered
    // twice, not about a database that has never seen the id before.
    const message = await deliver(
      addressA,
      "xrechnung-cii-valid-01.xml",
      `pm-redelivered-${randomUUID()}`,
    );

    const first = await store.ingest(ingestMessage(message));
    const second = await store.ingest(ingestMessage(message));

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);

    const documents = await app.withTenant(tenantA, (tx) =>
      listDocuments(tx, { search: "RE-2026-4471" }),
    );
    // One row however many times it arrives: the document is content-addressed
    // on (tenant, sha256), so even a fresh message id cannot create a second.
    expect(documents).toHaveLength(1);
  });

  it("survives two concurrent deliveries of the same message", async () => {
    const message = await deliver(
      addressA,
      "zugferd-en16931-01.xml",
      `pm-concurrent-${randomUUID()}`,
    );

    const [a, b] = await Promise.all([
      store.ingest(ingestMessage(message)),
      store.ingest(ingestMessage(message)),
    ]);

    // Exactly one wins; the loser reports a duplicate rather than failing.
    expect([a.accepted, b.accepted].filter(Boolean)).toHaveLength(1);

    const documents = await app.withTenant(tenantA, (tx) =>
      listDocuments(tx, { search: "KRB-3390" }),
    );
    expect(documents).toHaveLength(1);
  });

  /**
   * Misdirected mail and probes are the busiest part of the inbound attack
   * surface. They are recorded with no tenant, which the RLS policy renders
   * invisible to everyone, rather than discarded.
   */
  it("records an unroutable message without assigning it to a tenant", async () => {
    const message = await deliver("nobody@belegbox.de", "xrechnung-ubl-valid-01.xml");
    const result = await store.ingest(ingestMessage(message));

    expect(result).toEqual({ accepted: false, documents: [] });

    const row = await admin.withAdmin(async (client) => {
      const r = await client.query<{ tenant_id: string | null; recipient: string }>(
        "SELECT tenant_id, recipient FROM inbound_messages WHERE provider_message_id = $1",
        [message.providerMessageId],
      );
      return r.rows[0];
    });
    expect(row?.tenant_id).toBeNull();
    expect(row?.recipient).toBe("nobody@belegbox.de");
  });

  it("archives the bytes under retention and points the row at them", async () => {
    const message = await deliver(addressA, "missing-exemption-reason-ae-01.xml");
    const result = await store.ingest(ingestMessage(message));

    const sha = result.documents[0]?.sha256 as string;
    const key = `${sha.slice(0, 2)}/${sha}`;
    const original = await readFile(join(ROOT, "corpus", "missing-exemption-reason-ae-01.xml"));

    expect((await objects.get(key)).equals(original)).toBe(true);

    const documents = await app.withTenant(tenantA, (tx) =>
      listDocuments(tx, { search: "YE-2026-0231" }),
    );
    expect(documents).toHaveLength(1);

    const findings = await app.withTenant(tenantA, (tx) =>
      getFindings(tx, documents[0]?.id as string),
    );
    // D-002 from our domain layer; BR-AE-10 too when the validator is running.
    expect(findings.map((f) => f.code)).toContain("D-002");
  });
});
