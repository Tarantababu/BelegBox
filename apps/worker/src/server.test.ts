import { createHmac } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./server.js";
import { FilesystemDocumentStore } from "./store.js";

const POSTMARK = { webhookUser: "hook", webhookPassword: "s3cret-value" };
const MAILGUN_KEY = "key-test-signing";
const CORPUS = join(import.meta.dirname, "../../../corpus");

const basic = Buffer.from(`${POSTMARK.webhookUser}:${POSTMARK.webhookPassword}`).toString(
  "base64",
);

let app: FastifyInstance;
let store: FilesystemDocumentStore;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "belegbox-ingest-"));
  store = new FilesystemDocumentStore(root);
  app = await buildServer({
    store,
    postmark: POSTMARK,
    mailgun: { signingKey: MAILGUN_KEY },
  });
});

afterEach(async () => {
  await app.close();
});

async function postmarkPayload(messageId = "pm-1") {
  const xml = await readFile(join(CORPUS, "xrechnung-ubl-valid-01.xml"));
  return {
    MessageID: messageId,
    Date: "Thu, 27 Aug 2026 09:14:00 +0200",
    From: "rechnung@stadtwerke-beispiel.de",
    Subject: "Rechnung SWK-08-2026",
    OriginalRecipient: "sahin-doener-a7f31c9d@belegbox.de",
    Headers: [
      { Name: "Message-ID", Value: "<swk@stadtwerke-beispiel.de>" },
      { Name: "Authentication-Results", Value: "spf=pass; dkim=pass; dmarc=pass" },
    ],
    Attachments: [
      { Name: "rechnung.xml", ContentType: "application/xml", Content: xml.toString("base64") },
    ],
  };
}

function multipart(
  fields: Record<string, string>,
  files: Array<{ name: string; filename: string; contentType: string; body: Buffer }>,
): { body: Buffer; contentType: string } {
  const boundary = "----belegboxtest";
  const parts: Buffer[] = [];

  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  for (const f of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\n` +
          `Content-Type: ${f.contentType}\r\n\r\n`,
      ),
      f.body,
      Buffer.from("\r\n"),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function readRecords(): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(join(root, "records.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("health", () => {
  it("answers", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });
});

describe("postmark webhook", () => {
  it("rejects a request with no credentials", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/inbound/postmark",
      payload: await postmarkPayload(),
    });
    expect(res.statusCode).toBe(401);
    // The response must not say which half of the credential was wrong.
    expect(res.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects wrong credentials", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/inbound/postmark",
      headers: { authorization: `Basic ${Buffer.from("hook:wrong").toString("base64")}` },
      payload: await postmarkPayload(),
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts a signed message and archives the document", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/inbound/postmark",
      headers: { authorization: `Basic ${basic}` },
      payload: await postmarkPayload(),
    });

    expect(res.statusCode).toBe(202);
    const body = res.json() as {
      inboxSlug: string;
      documents: Array<{ sha256: string; format: string; status: string }>;
    };
    expect(body.inboxSlug).toBe("sahin-doener");
    expect(body.documents).toHaveLength(1);
    expect(body.documents[0]?.format).toBe("xrechnung_ubl");
    expect(body.documents[0]?.status).toBe("pending");

    const records = await readRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      invoiceNumber: "SWK-08-2026",
      issuedAt: "2026-08-22",
      legalClass: "einvoice",
      messageId: "<swk@stadtwerke-beispiel.de>",
    });

    // The archived bytes are the attachment, unmodified.
    const sha = body.documents[0]?.sha256 as string;
    const stored = await readFile(join(root, "objects", sha.slice(0, 2), sha));
    const original = await readFile(join(CORPUS, "xrechnung-ubl-valid-01.xml"));
    expect(stored.equals(original)).toBe(true);
  });

  // Every provider redelivers on timeout. Without idempotency that is a second
  // copy of the same invoice in the archive.
  it("treats a redelivered message as a duplicate", async () => {
    const payload = await postmarkPayload("pm-dup");
    const headers = { authorization: `Basic ${basic}` };

    const first = await app.inject({ method: "POST", url: "/inbound/postmark", headers, payload });
    const second = await app.inject({ method: "POST", url: "/inbound/postmark", headers, payload });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ status: "duplicate" });
    expect(await readRecords()).toHaveLength(1);
  });

  it("records a PDF with no XML rather than dropping it", async () => {
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n", "latin1");
    const res = await app.inject({
      method: "POST",
      url: "/inbound/postmark",
      headers: { authorization: `Basic ${basic}` },
      payload: {
        MessageID: "pm-pdf",
        OriginalRecipient: "sahin-doener-a7f31c9d@belegbox.de",
        Attachments: [
          { Name: "scan.pdf", ContentType: "application/pdf", Content: pdf.toString("base64") },
        ],
      },
    });

    expect(res.statusCode).toBe(202);
    const body = res.json() as { documents: Array<{ status: string }>; warnings: unknown[] };
    expect(body.documents[0]?.status).toBe("not_einvoice");
    expect(body.warnings.length).toBeGreaterThan(0);
  });
});

describe("mailgun webhook", () => {
  const signedFields = (over: Record<string, string> = {}) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const token = `tok-${Math.random().toString(16).slice(2)}`;
    return {
      timestamp,
      token,
      signature: createHmac("sha256", MAILGUN_KEY).update(timestamp + token).digest("hex"),
      recipient: "sahin-doener-a7f31c9d@belegbox.de",
      sender: "rechnung@stadtwerke-beispiel.de",
      subject: "Rechnung",
      "Message-Id": `<mg-${Math.random().toString(16).slice(2)}@mg>`,
      "message-headers": JSON.stringify([
        ["Authentication-Results", "spf=pass; dkim=pass; dmarc=pass"],
      ]),
      ...over,
    };
  };

  it("accepts a correctly signed multipart delivery", async () => {
    const xml = await readFile(join(CORPUS, "xrechnung-cii-valid-01.xml"));
    const { body, contentType } = multipart(signedFields(), [
      { name: "attachment-1", filename: "re.xml", contentType: "application/xml", body: xml },
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/inbound/mailgun",
      headers: { "content-type": contentType },
      payload: body,
    });

    expect(res.statusCode).toBe(202);
    const parsed = res.json() as { documents: Array<{ format: string }> };
    expect(parsed.documents[0]?.format).toBe("xrechnung_cii");
  });

  it("rejects a forged signature", async () => {
    const xml = await readFile(join(CORPUS, "xrechnung-cii-valid-01.xml"));
    const { body, contentType } = multipart(signedFields({ signature: "00".repeat(32) }), [
      { name: "attachment-1", filename: "re.xml", contentType: "application/xml", body: xml },
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/inbound/mailgun",
      headers: { "content-type": contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("write-once object store", () => {
  it("does not overwrite an object that already exists", async () => {
    const bytes = Buffer.from("<Invoice/>");
    const input = { sha256: "a".repeat(64), filename: "a.xml", bytes };

    const first = await store.putObject(input);
    const second = await store.putObject(input);

    expect(first.alreadyExisted).toBe(false);
    // Rehearses S3 Object Lock: code that assumes it can re-put breaks here,
    // in development, not in a Compliance-mode bucket.
    expect(second.alreadyExisted).toBe(true);
    expect(second.objectKey).toBe(first.objectKey);
  });
});
