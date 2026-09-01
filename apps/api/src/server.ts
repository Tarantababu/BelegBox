import cors from "@fastify/cors";
import { verifyChain, verifyEntryProof } from "@belegbox/archive";
import { proofForDocument, type Db } from "@belegbox/db";
import type { Registry } from "@belegbox/explain";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { buildAuthenticator, handleLogin, handleLogout, type Principal } from "./auth.js";
import type { EmailSender } from "@belegbox/mail";
import { handleResetConfirm, handleResetRequest } from "./password-reset.js";
import { MustangClient } from "@belegbox/validation";
import { registerDatevRoutes } from "./datev.js";
import { registerPaymentRoutes } from "./payments.js";
import { registerRoutes, STATUSES } from "./routes.js";
import { registerSearchRoutes } from "./search.js";
import { registerVerfahrensdokuRoutes } from "./verfahrensdoku.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ApiOptions {
  db: Db;
  /**
   * Overrides authentication. Tests inject a principal directly; production
   * leaves this unset and gets sessions and API keys.
   */
  authenticate?: (request: FastifyRequest) => Promise<Principal | undefined>;
  /** Set Secure on the session cookie. Off only for local http. */
  secureCookies?: boolean;
  logger?: boolean;
  /** Template registry for rendering explanations. */
  explain?: Registry;
  allowUnapprovedTemplates?: boolean;
  inboxDomain?: string;
  /** Origins allowed to call the API from a browser. */
  corsOrigins?: string[];
  /** Delivers password reset mail. Absent means reset is unavailable. */
  mail?: EmailSender;
  webUrl?: string;
  /** Development only: return the reset link in the response. */
  revealResetLink?: boolean;
  /**
   * How the archive is actually stored, for the Verfahrensdokumentation.
   *
   * Passed in rather than assumed: the document states the bucket and the
   * Object Lock mode as fact, and a wrong one is a false statement in evidence.
   */
  storage?: {
    backend: string;
    bucket: string;
    objectLockMode: string | null;
    retentionYears: number;
  };
}

export async function buildApi(opts: ApiOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  const authenticate = opts.authenticate ?? buildAuthenticator(opts.db);
  const resolveTenant = async (request: FastifyRequest): Promise<string | undefined> =>
    (await authenticate(request))?.tenantId;
  const resolveUser = async (request: FastifyRequest): Promise<string | undefined> =>
    (await authenticate(request))?.userId ?? undefined;

  if (opts.corsOrigins && opts.corsOrigins.length > 0) {
    // An explicit list, never a reflected origin. The API answers with tenant
    // data, so a permissive CORS policy would hand it to any page the user
    // happens to have open.
    await app.register(cors, { origin: opts.corsOrigins, credentials: true });
  }

  app.get("/health", async () => ({ status: "ok" }));

  app.post("/v1/auth/login", (request, reply) =>
    handleLogin({ db: opts.db, secureCookies: opts.secureCookies ?? true }, request, reply),
  );

  if (opts.mail) {
    const resetDeps = {
      db: opts.db,
      mail: opts.mail,
      webUrl: opts.webUrl ?? "http://localhost:3000",
      ...(opts.revealResetLink ? { revealLink: true } : {}),
    };
    app.post("/v1/auth/password-reset/request", (request, reply) =>
      handleResetRequest(resetDeps, request, reply),
    );
    app.post("/v1/auth/password-reset/confirm", (request, reply) =>
      handleResetConfirm(resetDeps, request, reply),
    );
  }

  app.post("/v1/auth/logout", async (request, reply) =>
    handleLogout(opts.db, await authenticate(request), request, reply),
  );

  app.get("/v1/auth/session", async (request, reply) => {
    const principal = await authenticate(request);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });
    return reply.send({
      tenantId: principal.tenantId,
      userId: principal.userId ?? null,
      role: principal.role ?? null,
      kind: principal.kind,
    });
  });

  /**
   * Integrity proof for one archived document.
   *
   * Returns everything an auditor needs to check the claim without trusting
   * this server: the canonical entry, the inclusion path, the day's sealed root
   * and the chain leading to it. `verifyEntryProof` recomputes the root from
   * the document alone.
   */
  app.get<{ Params: { id: string } }>("/v1/archive/proof/:id", async (request, reply) => {
    const tenantId = await resolveTenant(request);
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
      resolveTenant,
      ...(opts.allowUnapprovedTemplates !== undefined
        ? { allowUnapprovedTemplates: opts.allowUnapprovedTemplates }
        : {}),
      ...(opts.inboxDomain ? { inboxDomain: opts.inboxDomain } : {}),
    });
    registerPaymentRoutes(app, { db: opts.db, resolveTenant });
    registerDatevRoutes(app, { db: opts.db, resolveTenant });
    registerSearchRoutes(app, { db: opts.db, resolveTenant, statuses: STATUSES });
    if (opts.storage) {
      registerVerfahrensdokuRoutes(app, {
        db: opts.db,
        mustang: new MustangClient(),
        storage: opts.storage,
        resolveTenant,
        resolveUser,
      });
    }
  }

  return app;
}
