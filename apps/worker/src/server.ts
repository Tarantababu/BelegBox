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
import type { DocumentStore } from "./store.js";

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
  const outcome = ingestMessage(message);
  const result = await store.ingest(outcome);

  // 200 rather than an error: a redelivery is the provider behaving correctly,
  // and answering with a failure would make it try again.
  if (!result.accepted) {
    return reply.code(200).send({ status: "duplicate", documents: 0 });
  }

  return reply.code(202).send({
    status: "accepted",
    inboxSlug: outcome.inboxSlug ?? null,
    documents: result.documents,
    rejected: outcome.rejected.map((r) => ({ filename: r.filename, reason: r.reason })),
    warnings: outcome.warnings,
  });
}

export type { IngestOutcome };
