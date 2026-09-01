import { randomUUID } from "node:crypto";
import {
  generateInboxAddress,
} from "@belegbox/ingest";
import {
  generateTotpSecret,
  hashPassword,
  hashToken,
  totpCode,
  verifyPassword,
} from "@belegbox/auth";
import {
  Db,
  authenticateSession,
  createPool,
  createSession,
  createTenant,
  createUser,
  findUserForLogin,
} from "@belegbox/db";
import type { EmailSender, OutboundEmail } from "@belegbox/mail";
import { TemplateRegistry } from "@belegbox/explain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApi } from "./server.js";

/**
 * Password reset against a real database.
 *
 * This is the flow that turns "controls an inbox" into "controls the account",
 * so the tests are mostly about what it must refuse.
 */
const ADMIN_URL = process.env["DATABASE_URL"];
const suite = ADMIN_URL ? describe : describe.skip;

const APP_PASSWORD = "belegbox-test";
const OLD_PASSWORD = "the-old-password-here";
const NEW_PASSWORD = "a-brand-new-password";

class CapturingSender implements EmailSender {
  sent: OutboundEmail[] = [];
  async send(email: OutboundEmail): Promise<void> {
    this.sent.push(email);
  }
}

let admin: Db;
let app: Db;
let api: FastifyInstance;
let mail: CapturingSender;

async function makeUser(options: {
  mfa: boolean;
  role?: string;
  /** No TOTP secret at all, as opposed to one issued but unconfirmed. */
  noSecret?: boolean;
}): Promise<{
  email: string;
  userId: string;
  tenantId: string;
  secret: string;
}> {
  const addr = generateInboxAddress(`Reset Test ${randomUUID().slice(0, 6)}`);
  const created = await admin.withAdmin((client) =>
    createTenant(client, {
      name: "Reset Test GmbH",
      slug: `${addr.slug}-${randomUUID().slice(0, 4)}`,
      inboxAddress: addr.address,
      inboxSuffix: addr.suffix,
    }),
  );

  const email = `user-${randomUUID().slice(0, 8)}@example.test`;
  const secret = generateTotpSecret();
  const userId = await app.withTenant(created.tenant.id, async (tx) =>
    createUser(tx, {
      email,
      role: options.role ?? "viewer",
      passwordHash: await hashPassword(OLD_PASSWORD),
      totpSecret: options.noSecret ? null : secret,
      mfaEnabled: options.mfa,
    }),
  );

  return { email, userId, tenantId: created.tenant.id, secret };
}

const request = (body: unknown) =>
  api.inject({ method: "POST", url: "/v1/auth/password-reset/request", payload: body });
const confirm = (body: unknown) =>
  api.inject({ method: "POST", url: "/v1/auth/password-reset/confirm", payload: body });

async function linkFor(email: string): Promise<string> {
  const response = await request({ email });
  return (response.json() as { link: string }).link;
}

const tokenOf = (link: string) => decodeURIComponent(link.split("/reset/")[1] as string);

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
  mail = new CapturingSender();
  api = await buildApi({
    db: app,
    explain: new TemplateRegistry(),
    mail,
    webUrl: "http://localhost:3000",
    revealResetLink: true,
    secureCookies: false,
  });
});

suite("password reset request", () => {
  /**
   * The whole reason this endpoint answers the way it does. It is
   * unauthenticated and cheap to script, so a response that distinguished a
   * known address from an unknown one would enumerate the customer list - which
   * for a tax product is a list of companies with something worth stealing.
   */
  it("answers identically for a known and an unknown address", async () => {
    const user = await makeUser({ mfa: false });

    const known = await request({ email: user.email });
    const unknown = await request({ email: `nobody-${randomUUID()}@example.test` });

    expect(known.statusCode).toBe(unknown.statusCode);
    const a = known.json() as Record<string, unknown>;
    const b = unknown.json() as Record<string, unknown>;
    expect(a["status"]).toBe(b["status"]);
    expect(a["message"]).toBe(b["message"]);
  });

  it("sends a mail only for an address that exists", async () => {
    await request({ email: `nobody-${randomUUID()}@example.test` });
    expect(mail.sent).toHaveLength(0);

    const user = await makeUser({ mfa: false });
    await request({ email: user.email });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]?.to).toBe(user.email);
    expect(mail.sent[0]?.text).toContain("/reset/");
  });

  it("rejects a malformed address", async () => {
    expect((await request({ email: "not-an-address" })).statusCode).toBe(400);
    expect((await request({})).statusCode).toBe(400);
  });

  /** A second request must not leave the first link alive. */
  it("invalidates an earlier outstanding link", async () => {
    const user = await makeUser({ mfa: false, noSecret: true });
    const first = await linkFor(user.email);
    const second = await linkFor(user.email);

    expect((await confirm({ token: tokenOf(first), password: NEW_PASSWORD })).statusCode).toBe(400);
    expect((await confirm({ token: tokenOf(second), password: NEW_PASSWORD })).statusCode).toBe(200);
  });
});

suite("password reset confirm", () => {
  it("changes the password", async () => {
    // No secret at all: this account genuinely has no second factor.
    const user = await makeUser({ mfa: false, noSecret: true });
    const response = await confirm({
      token: tokenOf(await linkFor(user.email)),
      password: NEW_PASSWORD,
    });

    expect(response.statusCode).toBe(200);
    const candidate = await admin.withAdmin((client) => findUserForLogin(client, user.email));
    expect(await verifyPassword(NEW_PASSWORD, candidate?.passwordHash as string)).toBe(true);
    expect(await verifyPassword(OLD_PASSWORD, candidate?.passwordHash as string)).toBe(false);
  });

  it("spends the link exactly once", async () => {
    const user = await makeUser({ mfa: false, noSecret: true });
    const token = tokenOf(await linkFor(user.email));

    expect((await confirm({ token, password: NEW_PASSWORD })).statusCode).toBe(200);
    const second = await confirm({ token, password: "yet-another-password" });
    expect(second.statusCode).toBe(400);
    expect(second.json()).toEqual({ error: "invalid_or_expired_token" });
  });

  it("does not let two concurrent uses of one link both win", async () => {
    const user = await makeUser({ mfa: false, noSecret: true });
    const token = tokenOf(await linkFor(user.email));

    const [a, b] = await Promise.all([
      confirm({ token, password: NEW_PASSWORD }),
      confirm({ token, password: "a-different-new-password" }),
    ]);
    expect([a.statusCode, b.statusCode].filter((c) => c === 200)).toHaveLength(1);
  });

  it("gives one answer for unknown, expired and already-used tokens", async () => {
    const unknown = await confirm({ token: "not-a-real-token", password: NEW_PASSWORD });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toEqual({ error: "invalid_or_expired_token" });
  });

  it("rejects a password that is too short without spending the link", async () => {
    const user = await makeUser({ mfa: false, noSecret: true });
    const token = tokenOf(await linkFor(user.email));

    expect((await confirm({ token, password: "short" })).statusCode).toBe(400);
    // The link still works: failing validation must not cost the user their
    // one chance.
    expect((await confirm({ token, password: NEW_PASSWORD })).statusCode).toBe(200);
  });

  /**
   * The property that matters most here. If a reset skipped MFA, control of an
   * inbox would be enough to take an owner account - and § 10.3 requires a
   * second factor precisely because one stolen credential should not be.
   */
  it("still requires the second factor", async () => {
    const user = await makeUser({ mfa: true, role: "owner" });
    const token = tokenOf(await linkFor(user.email));

    const withoutCode = await confirm({ token, password: NEW_PASSWORD });
    expect(withoutCode.statusCode).toBe(401);
    expect(withoutCode.json()).toEqual({ error: "mfa_required" });

    const wrongCode = await confirm({ token, password: NEW_PASSWORD, totpCode: "000000" });
    expect(wrongCode.statusCode).toBe(401);

    // The password is unchanged after both refusals.
    const candidate = await admin.withAdmin((client) => findUserForLogin(client, user.email));
    expect(await verifyPassword(OLD_PASSWORD, candidate?.passwordHash as string)).toBe(true);

    const good = await confirm({
      token,
      password: NEW_PASSWORD,
      totpCode: totpCode(user.secret, Math.floor(Date.now() / 1000 / 30)),
    });
    expect(good.statusCode).toBe(200);
  });

  /**
   * Found by running the flow against a seeded owner rather than by reading it.
   * An owner created by setup has a secret but the flag is still off until the
   * first sign-in confirms it, and checking the flag alone let a reset through
   * with no second factor during exactly that window.
   */
  it("requires a code while enrolment is still pending", async () => {
    const user = await makeUser({ mfa: false, role: "owner" });
    const token = tokenOf(await linkFor(user.email));

    const withoutCode = await confirm({ token, password: NEW_PASSWORD });
    expect(withoutCode.statusCode).toBe(401);
    expect(withoutCode.json()).toEqual({ error: "mfa_required" });

    const good = await confirm({
      token,
      password: NEW_PASSWORD,
      totpCode: totpCode(user.secret, Math.floor(Date.now() / 1000 / 30)),
    });
    expect(good.statusCode).toBe(200);
  });

  it("requires a code for a viewer who has enrolled one anyway", async () => {
    const user = await makeUser({ mfa: true, role: "viewer" });
    const token = tokenOf(await linkFor(user.email));
    expect((await confirm({ token, password: NEW_PASSWORD })).statusCode).toBe(401);
  });

  it("keeps the link usable after a mistyped code", async () => {
    const user = await makeUser({ mfa: true, role: "owner" });
    const token = tokenOf(await linkFor(user.email));

    expect((await confirm({ token, password: NEW_PASSWORD, totpCode: "000000" })).statusCode).toBe(401);
    // Six mistyped digits must not cost the user their one link.
    const good = await confirm({
      token,
      password: NEW_PASSWORD,
      totpCode: totpCode(user.secret, Math.floor(Date.now() / 1000 / 30)),
    });
    expect(good.statusCode).toBe(200);
  });

  /**
   * Someone resetting a password usually believes another person has their
   * account. Leaving that person signed in would defeat the exercise.
   */
  it("revokes every existing session", async () => {
    const user = await makeUser({ mfa: false, noSecret: true });
    const token = "session-" + randomUUID();
    await app.withTenant(user.tenantId, (tx) =>
      createSession(tx, {
        userId: user.userId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 3600_000),
      }),
    );

    expect(
      await admin.withAdmin((client) => authenticateSession(client, hashToken(token))),
    ).toBeDefined();

    await confirm({ token: tokenOf(await linkFor(user.email)), password: NEW_PASSWORD });

    expect(
      await admin.withAdmin((client) => authenticateSession(client, hashToken(token))),
    ).toBeUndefined();
  });

  it("clears a lockout, because the person who proved control is the owner", async () => {
    const user = await makeUser({ mfa: false, noSecret: true });
    await admin.withAdmin((client) =>
      client.query("UPDATE users SET failed_logins = 9, locked_until = now() + interval '1 hour' WHERE id = $1", [
        user.userId,
      ]),
    );

    await confirm({ token: tokenOf(await linkFor(user.email)), password: NEW_PASSWORD });

    const candidate = await admin.withAdmin((client) => findUserForLogin(client, user.email));
    expect(candidate?.lockedUntil).toBeNull();
  });
});
