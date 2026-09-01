import {
  getDokuHtml,
  insertDoku,
  latestDoku,
  listDoku,
  verifyDokuChain,
  type Db,
} from "@belegbox/db";
import type { MustangClient } from "@belegbox/validation";
import { generate, renderHtml } from "@belegbox/verfahrensdoku";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { gatherFacts, probeValidator, type StorageDescription } from "./doku-facts.js";

export interface DokuRouteDeps {
  db: Db;
  mustang: MustangClient;
  storage: StorageDescription;
  resolveTenant: (request: FastifyRequest) => Promise<string | undefined>;
  resolveUser?: (request: FastifyRequest) => Promise<string | undefined>;
}

/**
 * M-11. The Verfahrensdokumentation.
 *
 * Generated from the running system and then kept, because GoBD Rz. 154 cares
 * about the fassung that was in force during the period under review. Nothing
 * here overwrites: a change produces fassung n+1, chained to the hash of n.
 */
export function registerVerfahrensdokuRoutes(
  app: FastifyInstance,
  deps: DokuRouteDeps,
): void {
  /** The fassungen on record, newest first, with the chain checked. */
  app.get("/v1/verfahrensdokumentation", async (request, reply) => {
    const tenantId = await deps.resolveTenant(request);
    if (!tenantId) return reply.code(401).send({ error: "unauthorized" });

    return deps.db.withTenant(tenantId, async (tx) => {
      const versions = await listDoku(tx);
      const chain = verifyDokuChain(versions);

      return reply.send({
        versions: versions.map((row) => ({
          version: row.version,
          contentHash: row.content_hash,
          previousHash: row.prev_hash,
          openItems: row.open_items,
          complete: row.complete,
          generatedAt: row.generated_at.toISOString(),
        })),
        chain,
      });
    });
  });

  /** One fassung, as it was handed over. */
  app.get<{ Params: { version: string } }>(
    "/v1/verfahrensdokumentation/:version",
    async (request, reply) => {
      const tenantId = await deps.resolveTenant(request);
      if (!tenantId) return reply.code(401).send({ error: "unauthorized" });

      const version = Number(request.params.version);
      if (!Number.isInteger(version) || version < 1) {
        return reply.code(400).send({ error: "version must be a positive integer" });
      }

      return deps.db.withTenant(tenantId, async (tx) => {
        const row = await getDokuHtml(tx, version);
        if (!row) return reply.code(404).send({ error: "not_found" });

        return reply
          .header("content-type", "text/html; charset=utf-8")
          .header("cache-control", "no-store")
          .send(row.html);
      });
    },
  );

  /**
   * Generates the next fassung.
   *
   * A POST rather than a GET, and stored rather than streamed, because
   * producing one is an event: it fixes what the system looked like on a day,
   * and that is the whole evidential value.
   */
  app.post("/v1/verfahrensdokumentation", async (request, reply) => {
    const tenantId = await deps.resolveTenant(request);
    if (!tenantId) return reply.code(401).send({ error: "unauthorized" });

    const generatedBy = deps.resolveUser ? await deps.resolveUser(request) : undefined;
    // Outside the transaction: an unreachable sidecar must not hold one open.
    const health = await probeValidator(deps.mustang);
    const generatedAt = new Date();

    return deps.db.withTenant(tenantId, async (tx) => {
      // Read inside the transaction that inserts, so two concurrent generations
      // cannot both claim the same fassung number. UNIQUE (tenant_id, version)
      // refuses the loser rather than letting the chain fork.
      const previous = await latestDoku(tx);
      const version = (previous?.version ?? 0) + 1;

      const input = await gatherFacts(
        { storage: deps.storage },
        tx,
        {
          version,
          generatedAt,
          health,
          ...(previous ? { previousHash: previous.content_hash } : {}),
        },
      );

      const doc = generate(input);
      const html = renderHtml(doc);

      const row = await insertDoku(tx, {
        version: doc.version,
        contentHash: doc.contentHash,
        prevHash: doc.previousHash ?? null,
        // Stored so the fassung can be re-derived and checked rather than
        // taken on trust.
        facts: input,
        html,
        openItems: doc.openItems.length,
        complete: doc.complete,
        ...(generatedBy ? { generatedBy } : {}),
      });

      return reply.code(201).send({
        version: row.version,
        contentHash: row.content_hash,
        previousHash: row.prev_hash,
        complete: row.complete,
        openItems: doc.openItems.map((item) => ({
          id: item.id,
          sectionId: item.sectionId,
          question: item.question,
          why: item.why,
        })),
        generatedAt: row.generated_at.toISOString(),
      });
    });
  });
}
