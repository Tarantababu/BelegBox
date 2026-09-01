import { randomUUID } from "node:crypto";
import multipart from "@fastify/multipart";
import {
  ingestMessage,
  mailgunSource,
  postmarkSource,
  type IngestOutcome,
  type IngestSource,
  type MailgunRequest,
  type PostmarkInboundPayload,
  type PostmarkRequest,
  type RawAttachment,
} from "@belegbox/ingest";
import Fastify, { type FastifyInstance } from "fastify";
import type { DocumentRecord, DocumentStore } from "./store.js";

export interface ServerOptions {
  store: DocumentStore;
  postmark?: { webhookUser: string; webhookPassword: string };
  mailgun?: { signingKey: string };
  /** Rejects a webhook body larger than this before parsing it. */
  maxBodyBytes?: number;
  logger?: boolean;
}

export const DEFAULT_MAX_BODY_BYTES = 30 * 1024 * 1024;

export async function buildServer(opts: ServerOptions): Promise<FastifyInstance> {
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: maxBodyBytes,
    // Providers retry aggressively; a slow archive write must not look like a
    // failure and trigger a duplicate delivery.
    requestTimeout: 30_000,
  });

  await app.register(multipart, {
    limits: { fileSize: maxBodyBytes, files: 20 },
  });

  app.get("/health", async () => ({ status: "ok" }));

  if (opts.postmark) {
    const source = postmarkSource(opts.postmark);
    app.post("/inbound/postmark", async (request, reply) => {
      const req: PostmarkRequest = {
        ...(request.headers.authorization
          ? { authorization: request.headers.authorization }
          : {}),
        payload: (request.body ?? {}) as PostmarkInboundPayload,
      };
      return handle(app, opts.store, source, req, reply);
    });
  }

  if (opts.mailgun) {
    const source = mailgunSource(opts.mailgun);
    app.post("/inbound/mailgun", async (request, reply) => {
      let req: MailgunRequest;
      try {
        req = await readMultipart(request);
      } catch (err) {
        // Malformed multipart is not retryable; say so rather than 500ing into
        // a redelivery loop.
        return reply.code(400).send({ error: (err as Error).message });
      }
      return handle(app, opts.store, source, req, reply);
    });
  }

  return app;
}

async function readMultipart(request: {
  parts: () => AsyncIterableIterator<
    | { type: "file"; fieldname: string; filename: string; mimetype: string; toBuffer: () => Promise<Buffer> }
    | { type: "field"; fieldname: string; value: unknown }
  >;
}): Promise<MailgunRequest> {
  const fields: Record<string, string> = {};
  const attachments: RawAttachment[] = [];

  for await (const part of request.parts()) {
    if (part.type === "file") {
      attachments.push({
        filename: part.filename || part.fieldname,
        contentType: part.mimetype || "application/octet-stream",
        bytes: await part.toBuffer(),
      });
    } else {
      fields[part.fieldname] = String(part.value ?? "");
    }
  }
  return { fields, attachments };
}

async function handle<Request>(
  app: FastifyInstance,
  store: DocumentStore,
  source: IngestSource<Request>,
  request: Request,
  reply: { code: (n: number) => { send: (body: unknown) => unknown } },
): Promise<unknown> {
  const verification = source.verify(request);
  if (!verification.ok) {
    // Deliberately terse: an attacker probing the endpoint learns nothing about
    // which part of the credential was wrong.
    app.log.warn({ provider: source.provider, reason: verification.reason }, "webhook rejected");
    return reply.code(401).send({ error: "unauthorized" });
  }

  const message = source.normalize(request);

  // Every provider redelivers on timeout. Without this, one slow archive write
  // becomes two copies of the same invoice.
  if (await store.hasSeenMessage(message.provider, message.providerMessageId)) {
    return reply.code(200).send({ status: "duplicate", documents: 0 });
  }

  const outcome = ingestMessage(message);
  const records: DocumentRecord[] = [];

  for (const doc of outcome.documents) {
    const put = await store.putObject({
      sha256: doc.sha256,
      filename: doc.filename,
      bytes: doc.bytes,
      contentType: doc.contentType,
    });

    records.push({
      id: randomUUID(),
      ...(outcome.inboxSlug ? { inboxSlug: outcome.inboxSlug } : {}),
      provider: message.provider,
      providerMessageId: message.providerMessageId,
      ...(message.messageId ? { messageId: message.messageId } : {}),
      receivedAt: message.receivedAt.toISOString(),
      from: message.from,
      subject: message.subject,
      senderAuth: message.senderAuth,
      filename: doc.filename,
      contentType: doc.contentType,
      sha256: doc.sha256,
      sizeBytes: doc.sizeBytes,
      objectKey: put.objectKey,
      ...(doc.detection
        ? {
            format: doc.detection.format,
            profileUrn: doc.detection.profile.urn,
            legalClass: doc.detection.profile.legalClass,
            ...(doc.detection.invoiceNumber ? { invoiceNumber: doc.detection.invoiceNumber } : {}),
            ...(doc.detection.issueDate ? { issuedAt: doc.detection.issueDate } : {}),
            ...(doc.detection.documentTypeCode
              ? { docTypeCode: doc.detection.documentTypeCode }
              : {}),
          }
        : {}),
      // Validation has not run yet, so nothing is `clean` at this point. The
      // only verdict ingest can reach on its own is that a document is not an
      // e-invoice at all.
      status:
        doc.detection && doc.detection.profile.legalClass === "einvoice"
          ? "pending"
          : "not_einvoice",
      warnings: outcome.warnings.map((w) => w.code),
    });
  }

  const { accepted } = await store.recordMessage(outcome, records);
  if (!accepted) {
    return reply.code(200).send({ status: "duplicate", documents: 0 });
  }

  return reply.code(202).send({
    status: "accepted",
    inboxSlug: outcome.inboxSlug ?? null,
    documents: records.map((r) => ({
      id: r.id,
      filename: r.filename,
      sha256: r.sha256,
      format: r.format ?? null,
      status: r.status,
    })),
    rejected: outcome.rejected.map((r) => ({ filename: r.filename, reason: r.reason })),
    warnings: outcome.warnings,
  });
}

export type { IngestOutcome };
