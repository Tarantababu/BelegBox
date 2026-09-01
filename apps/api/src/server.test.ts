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

describe("manual upload", () => {
  const tenant = async () => ({ tenantId: randomUUID(), kind: "session" as const });

  /** Records what was put, so a test can assert nothing was archived. */
  const store = () => {
    const puts: string[] = [];
    return {
      puts,
      store: {
        put: async (input: { key: string }) => {
          puts.push(input.key);
          return { key: input.key, alreadyExisted: false };
        },
        get: async () => Buffer.alloc(0),
        head: async () => ({ key: "", sizeBytes: 0 }),
      } as never,
    };
  };

  it("is not registered without somewhere to put the bytes", async () => {
    app = await buildApi({ db: stubDb([]), authenticate: tenant });
    const res = await app.inject({ url: "/v1/documents/upload", method: "POST", payload: {} });
    expect(res.statusCode).toBe(404);
  });

  /**
   * Upload deliberately differs from email here. A document that arrived by
   * email is kept whatever it turns out to be, because it arrived and § 14b
   * applies. An upload is someone choosing a file, and the wrong choice must
   * not land in an archive that Object Lock keeps for ten years.
   */
  it("refuses a file with no invoice in it, and archives nothing", async () => {
    const { puts, store: objectStore } = store();
    app = await buildApi({ db: stubDb([]), authenticate: tenant, objectStore });

    const res = await app.inject({
      url: "/v1/documents/upload",
      method: "POST",
      headers: { "content-type": "application/xml", "x-belegbox-filename": "notiz.xml" },
      payload: '<?xml version="1.0"?><notes><n>hello</n></notes>',
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("no_invoice");
    // The important half: nothing reached the archive.
    expect(puts).toEqual([]);
  });

  it("refuses an empty body", async () => {
    const { store: objectStore } = store();
    app = await buildApi({ db: stubDb([]), authenticate: tenant, objectStore });
    const res = await app.inject({
      url: "/v1/documents/upload",
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      payload: "",
    });
    expect(res.statusCode).toBe(400);
  });

  it("reads a body the browser mislabelled as text/plain", async () => {
    // Fastify's built-in text/plain parser hands the handler a string, and an
    // .xml labelled text/plain by the operating system was reported as an
    // empty body until this route replaced that parser.
    const { store: objectStore } = store();
    app = await buildApi({ db: stubDb([]), authenticate: tenant, objectStore });

    const res = await app.inject({
      url: "/v1/documents/upload",
      method: "POST",
      headers: { "content-type": "text/plain" },
      payload: "not an invoice",
    });
    // 422 rather than 400: the bytes arrived and were looked at.
    expect(res.statusCode).toBe(422);
  });

  it("leaves JSON routes on the default parser", async () => {
    // The text/plain override must not turn into a wildcard that eats JSON.
    app = await buildApi({ db: stubDb([]), authenticate: tenant });
    const res = await app.inject({
      url: "/v1/exports/datev",
      method: "POST",
      headers: { "content-type": "application/json" },
      payload: { from: "2026-08-01", to: "2026-08-31" },
    });
    expect(res.json().error).toBe("beraterNumber and mandantNumber are required");
  });
});

describe("account credentials", () => {
  const person = async () => ({
    tenantId: randomUUID(),
    userId: randomUUID(),
    role: "owner",
    kind: "session" as const,
  });
  const key = async () => ({ tenantId: randomUUID(), kind: "api_key" as const });

  /**
   * An API key authenticates a tenant, not a person. Letting one rotate a
   * second factor or mint further keys would turn a leaked integration
   * credential into ownership of the account.
   */
  it.each([
    ["/v1/account/mfa", "GET"],
    ["/v1/account/mfa/begin", "POST"],
    ["/v1/api-keys", "GET"],
    ["/v1/api-keys", "POST"],
  ])("refuses an API key at %s", async (url, method) => {
    app = await buildApi({ db: stubDb([]), authenticate: key });
    const res = await app.inject({ url, method: method as "GET" | "POST", payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it("will not rotate a second factor on a session alone", async () => {
    // A stolen cookie must not be upgradeable into permanent ownership by
    // swapping the authenticator.
    app = await buildApi({ db: stubDb({ email: "a@b.c", passwordHash: null }), authenticate: person });
    const res = await app.inject({
      url: "/v1/account/mfa/begin",
      method: "POST",
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("reauthentication_required");
  });

  it("keeps key management to the owner", async () => {
    app = await buildApi({
      db: stubDb([]),
      authenticate: async () => ({
        tenantId: randomUUID(),
        userId: randomUUID(),
        role: "accountant",
        kind: "session" as const,
      }),
    });
    expect((await app.inject({ url: "/v1/api-keys" })).statusCode).toBe(403);
  });
});
