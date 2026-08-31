import { randomUUID } from "node:crypto";
import type { Db } from "@belegbox/db";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApi } from "./server.js";

/**
 * Route-level behaviour only. The archive maths is covered in
 * packages/archive, and the isolation guarantee in packages/db against a real
 * PostgreSQL - neither is re-tested through a stub here.
 */
const stubDb = (result: unknown): Db =>
  ({ withTenant: async (_t: string, fn: (tx: unknown) => Promise<unknown>) => fn(result) }) as unknown as Db;

let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
});

describe("GET /v1/archive/proof/:id", () => {
  it("requires a tenant", async () => {
    app = await buildApi({ db: stubDb(undefined), resolveTenant: async () => undefined });
    const res = await app.inject({ url: `/v1/archive/proof/${randomUUID()}` });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an id that is not a UUID", async () => {
    app = await buildApi({ db: stubDb(undefined), resolveTenant: async () => randomUUID() });
    const res = await app.inject({ url: "/v1/archive/proof/not-a-uuid" });
    expect(res.statusCode).toBe(400);
  });

  // Unarchived, unsealed and belonging-to-someone-else must be indistinguishable.
  it("answers 404 when there is no proof", async () => {
    app = await buildApi({
      db: { withTenant: async () => undefined } as unknown as Db,
      resolveTenant: async () => randomUUID(),
    });
    const res = await app.inject({ url: `/v1/archive/proof/${randomUUID()}` });
    expect(res.statusCode).toBe(404);
  });
});
