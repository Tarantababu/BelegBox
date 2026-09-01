import cors from "@fastify/cors";
import { verifyChain, verifyEntryProof } from "@belegbox/archive";
import { proofForDocument, type Db } from "@belegbox/db";
import type { Registry } from "@belegbox/explain";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { registerRoutes } from "./routes.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ApiOptions {
  db: Db;
  /**
   * Resolves the caller's tenant. Real authentication - API keys and sessions -
   * is F1 week 4-5; until then this is injected so the archive endpoint can be
   * exercised without a half-built auth system standing in for one.
   */
  resolveTenant: (request: FastifyRequest) => Promise<string | undefined>;
  logger?: boolean;
  /** Template registry for rendering explanations. */
  explain?: Registry;
  allowUnapprovedTemplates?: boolean;
  inboxDomain?: string;
  /** Origins allowed to call the API from a browser. */
  corsOrigins?: string[];
}

export async function buildApi(opts: ApiOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });

  if (opts.corsOrigins && opts.corsOrigins.length > 0) {
    // An explicit list, never a reflected origin. The API answers with tenant
    // data, so a permissive CORS policy would hand it to any page the user
    // happens to have open.
    await app.register(cors, { origin: opts.corsOrigins, credentials: true });
  }

  app.get("/health", async () => ({ status: "ok" }));

  /**
   * Integrity proof for one archived document.
   *
   * Returns everything an auditor needs to check the claim without trusting
   * this server: the canonical entry, the inclusion path, the day's sealed root
   * and the chain leading to it. `verifyEntryProof` recomputes the root from
   * the document alone.
   */
  app.get<{ Params: { id: string } }>("/v1/archive/proof/:id", async (request, reply) => {
    const tenantId = await opts.resolveTenant(request);
    if (!tenantId) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const { id } = request.params;
    if (!UUID.test(id)) {
      return reply.code(400).send({ error: "document id must be a UUID" });
    }

    const result = await opts.db.withTenant(tenantId, (tx) => proofForDocument(tx, id));

    // Not archived, not sealed yet, or belonging to another tenant all answer
    // the same way. A distinguishable response would leak the existence of
    // another tenant's document.
    if (!result) {
      return reply.code(404).send({ error: "no proof available for this document" });
    }

    const selfCheck = verifyEntryProof(result.entry, result.proof);
    const chain = verifyChain(result.chain);

    if (!selfCheck || !chain.valid) {
      // Serving a proof that does not verify would be worse than serving none:
      // it looks like evidence and is not.
      request.log.error(
        { documentId: id, selfCheck, problems: chain.problems },
        "archive integrity check failed",
      );
      return reply.code(500).send({
        error: "archive integrity check failed",
        selfCheck,
        chainProblems: chain.problems,
      });
    }

    return reply.code(200).send({
      documentId: id,
      entry: result.entry,
      proof: result.proof,
      seal: result.link,
      chain: result.chain,
      verified: { inclusion: true, chain: true },
      algorithm: {
        tree: "RFC 6962 Merkle Tree Hash, SHA-256",
        leafPrefix: "0x00",
        nodePrefix: "0x01",
        canonicalEncoding: "belegbox.archive.v1",
      },
    });
  });

  if (opts.explain) {
    registerRoutes(app, {
      db: opts.db,
      explain: opts.explain,
      resolveTenant: opts.resolveTenant,
      ...(opts.allowUnapprovedTemplates !== undefined
        ? { allowUnapprovedTemplates: opts.allowUnapprovedTemplates }
        : {}),
      ...(opts.inboxDomain ? { inboxDomain: opts.inboxDomain } : {}),
    });
  }

  return app;
}
