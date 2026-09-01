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
    app = await buildApi({ db: stubDb(undefined), authenticate: async () => undefined });
    const res = await app.inject({ url: `/v1/archive/proof/${randomUUID()}` });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an id that is not a UUID", async () => {
    app = await buildApi({ db: stubDb(undefined), authenticate: async () => ({ tenantId: randomUUID(), kind: "session" as const }) });
    const res = await app.inject({ url: "/v1/archive/proof/not-a-uuid" });
    expect(res.statusCode).toBe(400);
  });

  // Unarchived, unsealed and belonging-to-someone-else must be indistinguishable.
  it("answers 404 when there is no proof", async () => {
    app = await buildApi({
      db: { withTenant: async () => undefined } as unknown as Db,
      authenticate: async () => ({ tenantId: randomUUID(), kind: "session" as const }),
    });
    const res = await app.inject({ url: `/v1/archive/proof/${randomUUID()}` });
    expect(res.statusCode).toBe(404);
  });
});

describe("what a missing dependency takes down with it", () => {
  const tenant = async () => ({ tenantId: randomUUID(), kind: "session" as const });

  /**
   * These routes were once nested inside `if (opts.explain)`. A registry that
   * failed to load silently removed the DATEV export, the archive search,
   * payments and the Beleg bundle - while /health still answered 200, so
   * nothing looked wrong until a user went to export their month.
   */
  it.each([
    ["/v1/documents/search", "GET"],
    ["/v1/exports/datev", "POST"],
    ["/v1/payments/sepa-file", "POST"],
  ])("serves %s without the explain registry", async (url, method) => {
    app = await buildApi({ db: stubDb([]), authenticate: tenant });
    const res = await app.inject({ url, method: method as "GET" | "POST", payload: {} });
    // Anything but 404: the route exists. What it answers with an empty body is
    // the route's own business and is covered elsewhere.
    expect(res.statusCode).not.toBe(404);
  });

  it("still gates the routes that genuinely cannot run without theirs", async () => {
    // No object store means no archived bytes to bundle. Registering the route
    // anyway would answer 500 where 404 is the truth.
    app = await buildApi({ db: stubDb([]), authenticate: tenant });
    const res = await app.inject({ url: "/v1/exports/belege", method: "POST", payload: {} });
    expect(res.statusCode).toBe(404);
  });
});

describe("health", () => {
  it("reports liveness without touching the database", async () => {
    // A liveness probe that fails during a database outage restarts every
    // replica and turns a recoverable outage into a crash loop.
    app = await buildApi({
      db: { withAdmin: async () => { throw new Error("database is gone"); } } as unknown as Db,
      authenticate: async () => undefined,
    });
    expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
  });

  it("refuses readiness when the database is unreachable", async () => {
    app = await buildApi({
      db: { withAdmin: async () => { throw new Error("database is gone"); } } as unknown as Db,
      authenticate: async () => undefined,
    });
    const res = await app.inject({ url: "/health/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: "unavailable", database: "unreachable" });
  });

  it("reports which features this instance can actually serve", async () => {
    app = await buildApi({
      db: { withAdmin: async (fn: (c: unknown) => Promise<unknown>) => fn({ query: async () => ({ rows: [] }) }) } as unknown as Db,
      authenticate: async () => undefined,
    });
    const res = await app.inject({ url: "/health/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json().features).toMatchObject({ belegBundle: false, explanations: false });
  });
});
