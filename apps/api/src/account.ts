import {
  RECOVERY_CODE_COUNT,
  generateApiKey,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  hashToken,
  totpUri,
  verifyPassword,
  verifyTotp,
} from "@belegbox/auth";
import {
  activatePendingTotp,
  countUnusedRecoveryCodes,
  createApiKey,
  discardPendingTotp,
  getAccountUser,
  getPendingTotp,
  listApiKeys,
  replaceRecoveryCodes,
  revokeApiKey,
  revokeSessionsForUser,
  setPendingTotp,
  setUserLocale,
  type Db,
} from "@belegbox/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { issueSession, type Principal } from "./auth.js";

/** How long an unconfirmed secret stays valid. Long enough to scan, not to sit. */
const PENDING_TTL_MS = 15 * 60 * 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AccountRouteDeps {
  db: Db;
  authenticate: (request: FastifyRequest) => Promise<Principal | undefined>;
  /** The issuer shown in the authenticator app. */
  issuer?: string | undefined;
  secureCookies?: boolean | undefined;
}

/**
 * Re-authenticates before a change to the credentials themselves.
 *
 * A live session is not enough to rotate a second factor or mint an API key. A
 * stolen session cookie would otherwise be an escalation: swap the
 * authenticator, and the theft becomes permanent ownership of the account. The
 * password is asked for again, at the moment of the change.
 */
async function reauthenticate(
  deps: AccountRouteDeps,
  principal: Principal,
  password: string,
): Promise<boolean> {
  if (!password || !principal.userId) return false;

  const user = await deps.db.withTenant(principal.tenantId, (tx) =>
    getAccountUser(tx, principal.userId as string),
  );
  if (!user?.passwordHash) return false;
  return verifyPassword(password, user.passwordHash);
}

async function requirePerson(
  deps: AccountRouteDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<Principal | undefined> {
  const principal = await deps.authenticate(request);
  if (!principal || !principal.userId) {
    // An API key authenticates a tenant, not a person, and must not be able to
    // rotate a person's second factor or mint another key.
    await reply.code(401).send({ error: "unauthorized" });
    return undefined;
  }
  return principal;
}

export function registerAccountRoutes(app: FastifyInstance, deps: AccountRouteDeps): void {
  const issuer = deps.issuer ?? "Belegbox";

  /** What the account screen needs to render. Never a secret. */
  app.get("/v1/account/mfa", async (request, reply) => {
    const principal = await requirePerson(deps, request, reply);
    if (!principal) return reply;

    return deps.db.withTenant(principal.tenantId, async (tx) => {
      const [pending, codesLeft] = await Promise.all([
        getPendingTotp(tx, principal.userId as string),
        countUnusedRecoveryCodes(tx, principal.userId as string),
      ]);

      return reply.send({
        enrolled: true,
        recoveryCodesLeft: codesLeft,
        pending: pending ? { startedAt: pending.at.toISOString() } : null,
      });
    });
  });

  /**
   * Issues a new secret, without touching the one in use.
   *
   * Two steps, because replacing the secret the moment it is issued locks out
   * anyone whose authenticator did not take it - a mistyped scan, a phone with
   * a wrong clock - and the account they are locked out of holds ten years of
   * tax records.
   */
  app.post<{ Body: { password?: string } }>("/v1/account/mfa/begin", async (request, reply) => {
    const principal = await requirePerson(deps, request, reply);
    if (!principal) return reply;

    if (!(await reauthenticate(deps, principal, request.body?.password ?? ""))) {
      return reply.code(401).send({
        error: "reauthentication_required",
        message: "Bitte das aktuelle Passwort eingeben.",
      });
    }

    const secret = generateTotpSecret();
    const user = await deps.db.withTenant(principal.tenantId, async (tx) => {
      await setPendingTotp(tx, principal.userId as string, secret);
      return getAccountUser(tx, principal.userId as string);
    });

    // Returned once, to be scanned. It is not the active factor until a code
    // from it comes back.
    return reply.send({
      secret,
      // Labelled with the email: someone opening their authenticator should see
      // which account this is, not a UUID.
      uri: totpUri(secret, user?.email ?? (principal.userId as string), issuer),
      expiresInSeconds: PENDING_TTL_MS / 1000,
    });
  });

  /**
   * Activates the pending secret, and only then.
   *
   * Recovery codes are replaced in the same transaction: the old set belonged
   * to the authenticator being retired, and leaving them live would keep a way
   * in the user believes they have revoked.
   */
  app.post<{ Body: { code?: string } }>("/v1/account/mfa/confirm", async (request, reply) => {
    const principal = await requirePerson(deps, request, reply);
    if (!principal) return reply;

    const code = (request.body?.code ?? "").trim();
    if (!code) return reply.code(400).send({ error: "code is required" });

    const result = await deps.db.withTenant(principal.tenantId, async (tx) => {
      const pending = await getPendingTotp(tx, principal.userId as string);
      if (!pending) return { error: "no_pending_secret" as const };

      if (Date.now() - pending.at.getTime() > PENDING_TTL_MS) {
        await discardPendingTotp(tx, principal.userId as string);
        return { error: "expired" as const };
      }

      if (!verifyTotp(pending.secret, code)) {
        // The pending secret survives a wrong code: the user is mid-scan and
        // discarding it here would make them start over on every typo.
        return { error: "invalid_code" as const };
      }

      const activated = await activatePendingTotp(tx, principal.userId as string);
      if (!activated) return { error: "no_pending_secret" as const };

      const codes = generateRecoveryCodes(RECOVERY_CODE_COUNT);
      await replaceRecoveryCodes(
        tx,
        principal.userId as string,
        codes.map(hashRecoveryCode),
      );
      return { codes };
    });

    if ("error" in result) {
      const status = result.error === "invalid_code" ? 401 : 409;
      return reply.code(status).send({ error: result.error });
    }

    // Every session signed in against the old authenticator. Ending them is the
    // point of rotating: if the reason for rotating is that someone else had
    // access, leaving their session alive achieves nothing.
    //
    // That includes this one, so a fresh session is issued straight after -
    // otherwise the user is signed out at the exact moment they are being shown
    // recovery codes they have one chance to write down.
    await deps.db.withAdmin((client) =>
      revokeSessionsForUser(client, principal.userId as string),
    );
    await issueSession(
      { db: deps.db, secureCookies: deps.secureCookies ?? true },
      principal.userId as string,
      principal.tenantId,
      request,
      reply,
    );

    // Shown once. There is no path that displays them again.
    return reply.send({ recoveryCodes: result.codes, sessionsRevoked: true });
  });

  /**
   * The interface language, read back.
   *
   * A session already carries it, so this exists for a client that wants to
   * know without holding one - and for the account screen after a change, so
   * it renders what the database now says rather than what it just sent.
   */
  app.get("/v1/account/language", async (request, reply) => {
    const principal = await requirePerson(deps, request, reply);
    if (!principal) return reply;

    return deps.db.withTenant(principal.tenantId, async (tx) => {
      const user = await getAccountUser(tx, principal.userId as string);
      if (!user) return reply.code(404).send({ error: "not found" });
      return reply.send({ language: user.locale });
    });
  });

  /**
   * Changes it.
   *
   * No password. This is the one setting on the account screen that is not a
   * credential: it cannot lock anyone out, cannot be used to take an account,
   * and reveals nothing. Asking for a password here would train people to type
   * it for trivia, which is the habit that makes the prompt on the MFA and key
   * routes above worth anything.
   *
   * `requirePerson` still applies. An API key authenticates a business and has
   * no language of its own; letting one write `users.locale` would mean a till
   * system silently changing the interface of whoever logs in next.
   *
   * The set of valid codes is enforced by the CHECK constraint from migration
   * 0012 rather than by a list here - see the note in that migration. A code
   * outside it arrives as 23514 and is answered as a 400, not a 500.
   */
  app.put<{ Body: { language?: string } }>("/v1/account/language", async (request, reply) => {
    const principal = await requirePerson(deps, request, reply);
    if (!principal) return reply;

    const language = request.body?.language?.trim() ?? "";
    if (!/^[a-z]{2}$/.test(language)) {
      return reply.code(400).send({ error: "language must be a two-letter language code" });
    }

    try {
      const changed = await deps.db.withTenant(principal.tenantId, (tx) =>
        setUserLocale(tx, principal.userId as string, language),
      );
      if (!changed) return reply.code(404).send({ error: "not found" });
    } catch (err) {
      if ((err as { code?: string }).code === "23514") {
        return reply.code(400).send({ error: `language "${language}" is not supported` });
      }
      throw err;
    }

    return reply.send({ language });
  });

  app.get("/v1/api-keys", async (request, reply) => {
    const principal = await requirePerson(deps, request, reply);
    if (!principal) return reply;
    if (principal.role !== "owner") {
      return reply.code(403).send({ error: "forbidden" });
    }

    return deps.db.withTenant(principal.tenantId, async (tx) => {
      const keys = await listApiKeys(tx);
      return reply.send({
        keys: keys.map((key) => ({
          id: key.id,
          name: key.name,
          environment: key.environment,
          // Enough to recognise a key in a list, far too little to use it.
          prefix: key.prefix,
          scopes: key.scopes,
          createdAt: key.created_at.toISOString(),
          expiresAt: key.expires_at?.toISOString() ?? null,
          lastUsedAt: key.last_used_at?.toISOString() ?? null,
          revokedAt: key.revoked_at?.toISOString() ?? null,
        })),
      });
    });
  });

  /**
   * Mints a key. The token is returned once and never again.
   *
   * Only the hash is stored, so there is no path - not for support, not for an
   * operator - that reveals it a second time. A lost key is replaced, not
   * recovered.
   */
  app.post<{
    Body: { name?: string; environment?: string; password?: string; scopes?: string[] };
  }>("/v1/api-keys", async (request, reply) => {
    const principal = await requirePerson(deps, request, reply);
    if (!principal) return reply;
    if (principal.role !== "owner") {
      return reply.code(403).send({ error: "forbidden" });
    }

    const name = (request.body?.name ?? "").trim().slice(0, 80);
    if (!name) return reply.code(400).send({ error: "name is required" });

    const environment = request.body?.environment === "test" ? "test" : "live";

    if (!(await reauthenticate(deps, principal, request.body?.password ?? ""))) {
      return reply.code(401).send({
        error: "reauthentication_required",
        message: "Bitte das aktuelle Passwort eingeben.",
      });
    }

    const { token, prefix } = generateApiKey(environment);
    const id = await deps.db.withTenant(principal.tenantId, (tx) =>
      createApiKey(tx, {
        name,
        environment,
        prefix,
        tokenHash: hashToken(token),
        scopes: Array.isArray(request.body?.scopes) ? request.body.scopes.slice(0, 20) : [],
        createdBy: principal.userId ?? null,
      }),
    );

    return reply.code(201).send({ id, name, environment, prefix, token });
  });

  app.delete<{ Params: { id: string } }>("/v1/api-keys/:id", async (request, reply) => {
    const principal = await requirePerson(deps, request, reply);
    if (!principal) return reply;
    if (principal.role !== "owner") {
      return reply.code(403).send({ error: "forbidden" });
    }
    if (!UUID.test(request.params.id)) {
      return reply.code(400).send({ error: "id must be a UUID" });
    }

    const revoked = await deps.db.withTenant(principal.tenantId, (tx) =>
      revokeApiKey(tx, request.params.id),
    );
    // A key belonging to another tenant is invisible under RLS and answers the
    // same as one already revoked, which is what it should look like.
    return revoked ? reply.send({ revoked: true }) : reply.code(404).send({ error: "not_found" });
  });
}
