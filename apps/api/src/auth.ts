import {
  attemptLogin,
  countsAsFailure,
  generateSessionToken,
  hashToken,
  sessionExpiry,
} from "@belegbox/auth";
import {
  authenticateApiKey,
  authenticateSession,
  consumeTotp,
  createSession,
  findUserForLogin,
  recordLoginAttempt,
  revokeSession,
  setTotpSecret,
  touchSession,
  type Db,
} from "@belegbox/db";
import type { FastifyReply, FastifyRequest } from "fastify";

export const SESSION_COOKIE = "belegbox_session";

export interface Principal {
  tenantId: string;
  /** Absent for an API key, which authenticates a tenant rather than a person. */
  userId?: string;
  role?: string;
  locale?: string;
  kind: "session" | "api_key";
  scopes?: string[];
  environment?: "live" | "test";
}

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== "string") return undefined;
  const [scheme, value] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && value ? value : undefined;
}

function sessionCookie(request: FastifyRequest): string | undefined {
  const header = request.headers.cookie;
  if (typeof header !== "string") return undefined;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

/**
 * Identifies the caller.
 *
 * Two credentials, one answer. A browser presents a session cookie; an
 * integrator presents `sk_live_…` as a bearer token. Both resolve to a tenant
 * before any query runs, and neither is trusted beyond that: the tenant id goes
 * into `withTenant`, and Row Level Security does the enforcing.
 *
 * Lookups are by token hash through a SECURITY DEFINER function, because this
 * is the step that establishes the scope - there is no scope to look it up
 * under.
 */
export function buildAuthenticator(db: Db) {
  return async function authenticate(request: FastifyRequest): Promise<Principal | undefined> {
    const bearer = bearerToken(request);
    if (bearer) {
      const key = await db.withAdmin((client) =>
        authenticateApiKey(client, hashToken(bearer)),
      );
      return key
        ? {
            tenantId: key.tenantId,
            kind: "api_key",
            scopes: key.scopes,
            environment: key.environment,
          }
        : undefined;
    }

    const cookie = sessionCookie(request);
    if (!cookie) return undefined;

    const session = await db.withAdmin((client) =>
      authenticateSession(client, hashToken(cookie)),
    );
    if (!session) return undefined;

    // Fire and forget: a failed last-seen update must not fail the request.
    void db
      .withAdmin((client) => touchSession(client, session.sessionId))
      .catch(() => undefined);

    return {
      tenantId: session.tenantId,
      userId: session.userId,
      role: session.role,
      locale: session.locale,
      kind: "session",
    };
  };
}

export interface LoginRequestBody {
  email?: string;
  password?: string;
  totpCode?: string;
}

export interface LoginDeps {
  db: Db;
  secureCookies: boolean;
}

/**
 * Signs a user in.
 *
 * The response says as little as it can: a wrong password, an unknown address
 * and a locked account all answer 401 with the same body. Only the two MFA
 * outcomes are distinguishable, and only after the password was correct - the
 * client cannot render a code field otherwise.
 */
export async function handleLogin(
  deps: LoginDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const body = (request.body ?? {}) as LoginRequestBody;
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!email || !password) {
    return reply.code(400).send({ error: "email and password are required" });
  }

  const candidate = await deps.db.withAdmin((client) => findUserForLogin(client, email));
  const outcome = await attemptLogin(candidate, {
    password,
    ...(typeof body.totpCode === "string" ? { totpCode: body.totpCode } : {}),
  });

  if (!outcome.ok) {
    if (outcome.userId && countsAsFailure(outcome.reason)) {
      await deps.db.withAdmin((client) => recordLoginAttempt(client, outcome.userId as string, false));
    }
    // The three MFA outcomes are distinguishable, and safely so: all of them
    // are reachable only after the password was already correct, so an attacker
    // learns nothing they did not have. Collapsing them would tell a user who
    // mistyped a code that their password was wrong.
    if (
      outcome.reason === "mfa_required" ||
      outcome.reason === "mfa_invalid" ||
      outcome.reason === "mfa_enrollment_required"
    ) {
      return reply.code(401).send({ error: outcome.reason });
    }
    // Wrong password, unknown account and locked all look identical.
    return reply.code(401).send({ error: "invalid_credentials" });
  }

  // Claim the time step before issuing anything. A code seen inside its window
  // - relayed by a phishing page, read over a shoulder - must be useless to
  // whoever saw it.
  if (outcome.totpCounter !== undefined) {
    const claimed = await deps.db.withAdmin((client) =>
      consumeTotp(client, outcome.userId, outcome.totpCounter as number),
    );
    if (!claimed) {
      await deps.db.withAdmin((client) => recordLoginAttempt(client, outcome.userId, false));
      return reply.code(401).send({ error: "mfa_invalid" });
    }
  }

  if (outcome.activatedMfa) {
    // The code verified against the pending secret, so the second factor is now
    // genuinely configured rather than merely issued.
    await deps.db.withTenant(outcome.tenantId, (tx) =>
      setTotpSecret(tx, outcome.userId, candidate?.totpSecret ?? null, true),
    );
  }

  const token = generateSessionToken();
  await deps.db.withTenant(outcome.tenantId, (tx) =>
    createSession(tx, {
      userId: outcome.userId,
      tokenHash: hashToken(token),
      expiresAt: sessionExpiry(),
      ip: request.ip,
      userAgent: typeof request.headers["user-agent"] === "string"
        ? request.headers["user-agent"].slice(0, 500)
        : null,
    }),
  );
  await deps.db.withAdmin((client) => recordLoginAttempt(client, outcome.userId, true));

  // httpOnly so page scripts cannot read it, sameSite=lax so it does not ride
  // along on a cross-site POST, secure everywhere but local http.
  reply.header(
    "set-cookie",
    [
      `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${Math.floor((sessionExpiry().getTime() - Date.now()) / 1000)}`,
      ...(deps.secureCookies ? ["Secure"] : []),
    ].join("; "),
  );

  return reply.code(200).send({
    tenantId: outcome.tenantId,
    userId: outcome.userId,
    role: outcome.role,
    locale: outcome.locale,
    ...(outcome.activatedMfa ? { mfaActivated: true } : {}),
  });
}

export async function handleLogout(
  db: Db,
  principal: Principal | undefined,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const cookie = sessionCookie(request);
  if (principal?.kind === "session" && cookie) {
    const session = await db.withAdmin((client) =>
      authenticateSession(client, hashToken(cookie)),
    );
    if (session) {
      await db.withTenant(session.tenantId, (tx) => revokeSession(tx, session.sessionId));
    }
  }

  // Cleared unconditionally: a client asking to sign out gets signed out even
  // if the session was already gone.
  reply.header(
    "set-cookie",
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
  return reply.code(204).send();
}
