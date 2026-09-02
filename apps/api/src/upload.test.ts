import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { Db, createPool, createTenant } from "@belegbox/db";
import { generateInboxAddress } from "@belegbox/ingest";
import { loadTemplateDir } from "@belegbox/explain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApi } from "./server.js";

/**
 * Manual upload against a real database.
 *
 * The verdict is the only place the bug this guards was visible, and a verdict
 * needs a row. A stubbed database can show that bytes reached the archive - it
 * cannot show that the document was judged on the invoice rather than on the
 * envelope it arrived in, which is the thing that was wrong.
 *
 * Skipped without DATABASE_URL, like the other database-backed suites here.
 */
const ADMIN_URL = process.env["DATABASE_URL"];
const suite = ADMIN_URL ? describe : describe.skip;

const APP_PASSWORD = "belegbox-test";
const CORPUS = join(import.meta.dirname, "../../../corpus");

/** A PDF/A-3-shaped container: enough structure for the extractor to walk. */
function pdfWithAttachment(name: string, xml: Buffer): Buffer {
  const stream = deflateSync(xml);
  const head = Buffer.from(
    `%PDF-1.7\n` +
      `1 0 obj << /Type /Catalog >> endobj\n` +
      `2 0 obj << /Type /Filespec /F (${name}) /UF (${name}) /EF << /F 3 0 R >> >> endobj\n` +
      `3 0 obj << /Type /EmbeddedFile /Subtype /text#2Fxml /Filter /FlateDecode ` +
      `/Length ${stream.length} >> stream\n`,
    "latin1",
  );
  const tail = Buffer.from(`\nendstream endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`, "latin1");
  return Buffer.concat([head, stream, tail]);
}

/** Keeps the archived bytes in memory; the point here is the verdict. */
function memoryStore() {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    store: {
      put: async (input: { key: string; bytes: Buffer }) => {
        objects.set(input.key, input.bytes);
        return { key: input.key, alreadyExisted: false };
      },
      get: async (key: string) => objects.get(key) ?? Buffer.alloc(0),
      head: async (key: string) => ({ key, sizeBytes: objects.get(key)?.length ?? 0 }),
    } as never,
  };
}

let admin: Db;
let app: Db;
let api: FastifyInstance;
let tenantId: string;
let objects: Map<string, Buffer>;

beforeAll(async () => {
  if (!ADMIN_URL) return;
  admin = new Db(createPool(ADMIN_URL, 4));
  await admin.withAdmin(async (client) => {
    await client.query(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'belegbox_app') THEN
           CREATE ROLE belegbox_app LOGIN PASSWORD '${APP_PASSWORD}';
         ELSE ALTER ROLE belegbox_app LOGIN PASSWORD '${APP_PASSWORD}';
         END IF;
       END $$;`,
    );
  });
  const url = new URL(ADMIN_URL);
  url.username = "belegbox_app";
  url.password = APP_PASSWORD;
  app = new Db(createPool(url.toString(), 6));
}, 60_000);

afterAll(async () => {
  await api?.close();
  await app?.close();
  await admin?.close();
});

beforeEach(async () => {
  if (!ADMIN_URL) return;
  await api?.close();

  const addr = generateInboxAddress(`Upload Test ${randomUUID().slice(0, 6)}`);
  const created = await admin.withAdmin((client) =>
    createTenant(client, {
      name: "Upload Test GmbH",
      slug: `${addr.slug}-${randomUUID().slice(0, 4)}`,
      inboxAddress: addr.address,
      inboxSuffix: addr.suffix,
    }),
  );
  tenantId = created.tenant.id;

  const store = memoryStore();
  objects = store.objects;
  api = await buildApi({
    db: app,
    // The document routes are registered only with a template registry, and
    // the verdict is read back through them.
    explain: await loadTemplateDir(),
    allowUnapprovedTemplates: true,
    authenticate: async () => ({ tenantId, kind: "session" as const }),
    objectStore: store.store,
    secureCookies: false,
  });
});

const upload = (filename: string, bytes: Buffer, contentType: string) =>
  api.inject({
    method: "POST",
    url: "/v1/documents/upload",
    headers: { "content-type": contentType, "x-belegbox-filename": filename },
    payload: bytes,
  });

suite("manual upload, with a database behind it", () => {
  /**
   * The bug: `doc.bytes` is the container that gets archived, `doc.payload` is
   * the XML pulled out of it, and this route validated the former. Detection
   * saw `%PDF-` and answered "extract the embedded XML first", so a perfectly
   * good ZUGFeRD invoice was recorded as not_einvoice with an internal note.
   *
   * The same file arriving by email was always fine - the worker uses the
   * payload - so the two paths disagreed about the same document.
   */
  it("judges a ZUGFeRD PDF on the invoice inside it", async () => {
    const xml = await readFile(join(CORPUS, "zugferd-en16931-01.xml"));
    const res = await upload("rechnung.pdf", pdfWithAttachment("factur-x.xml", xml), "application/pdf");

    expect(res.statusCode).toBe(201);
    const doc = res.json().documents[0];

    // EN 16931 / COMFORT is a real e-invoice. Anything that reports otherwise
    // is reading the wrapper.
    expect(doc.status).not.toBe("not_einvoice");

    const detail = await api.inject({ url: `/v1/documents/${doc.id}` });
    expect(detail.json().format).toBe("zugferd");
    expect(
      detail.json().findings.map((f: { messageRaw: string }) => f.messageRaw).join(" "),
    ).not.toMatch(/embedded invoice XML/);

    // The archive still holds the container, byte for byte - the PDF is the
    // document of record under § 14b, not the XML we pulled out of it.
    expect([...objects.values()][0]?.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("records a bare XRechnung the same way", async () => {
    const xml = await readFile(join(CORPUS, "xrechnung-ubl-valid-01.xml"));
    const res = await upload("rechnung.xml", xml, "application/xml");

    expect(res.statusCode).toBe(201);
    const detail = await api.inject({ url: `/v1/documents/${res.json().documents[0].id}` });
    expect(detail.json().format).toBe("xrechnung_ubl");
  });
});
