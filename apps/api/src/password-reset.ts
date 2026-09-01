import { randomBytes } from "node:crypto";
import {
  generateSessionToken,
  hashPassword,
  hashToken,
  requiresMfa,
  verifyTotpStep,
} from "@belegbox/auth";
import {
  applyPasswordReset,
  claimPasswordReset,
  consumeTotp,
  findPasswordReset,
  findUserForLogin,
  issuePasswordReset,
  revokeSessionsForUser,
  type Db,
} from "@belegbox/db";
import type { EmailSender } from "@belegbox/mail";
import type { FastifyReply, FastifyRequest } from "fastify";

/** An hour. Long enough to find the mail, short enough that a stale one is dead. */
export const RESET_TTL_MS = 60 * 60 * 1000;

export interface ResetDeps {
  db: Db;
  mail: EmailSender;
  /** Base URL the link points at, e.g. https://app.belegbox.de */
  webUrl: string;
  /** Development only: return the link in the response instead of guessing at mail. */
  revealLink?: boolean;
}

function resetEmail(link: string): { subject: string; text: string } {
  return {
    subject: "Passwort zurücksetzen",
    text: [
      "Jemand hat angefordert, das Passwort für dieses Belegbox-Konto zurückzusetzen.",
      "",
      "Wenn du das warst, öffne diesen Link. Er gilt eine Stunde und nur einmal:",
      "",
      `    ${link}`,
      "",
      "Wenn du das nicht warst, musst du nichts tun. Solange der Link nicht",
      "geöffnet wird, ändert sich an deinem Konto nichts.",
      "",
      "Belegbox",
    ].join("\n"),
  };
}

/**
 * Starts a reset.
 *
 * Answers 202 for every syntactically valid address, whether or not it exists.
 * Saying "no account with that address" would turn this into the account
 * enumeration oracle the login endpoint is careful not to be - and this one is
 * unauthenticated and cheap to script.
 *
 * A delivery failure is logged and swallowed for the same reason: Postmark
 * rejecting a recipient must not become a signal.
 */
export async function handleResetRequest(
  deps: ResetDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const body = (request.body ?? {}) as { email?: string };
  const email = typeof body.email === "string" ? body.email.trim() : "";

  if (!email || !email.includes("@") || email.length > 320) {
    return reply.code(400).send({ error: "a valid email is required" });
  }

  const user = await deps.db.withAdmin((client) => findUserForLogin(client, email));
  let link: string | undefined;

  if (user) {
    const token = generateSessionToken();
    await deps.db.withAdmin((client) =>
      issuePasswordReset(
        client,
        user.userId,
        hashToken(token),
        new Date(Date.now() + RESET_TTL_MS),
        request.ip,
      ),
    );

    link = `${deps.webUrl.replace(/\/$/, "")}/reset/${encodeURIComponent(token)}`;
    const message = resetEmail(link);
    try {
      await deps.mail.send({ to: email, subject: message.subject, text: message.text });
    } catch (err) {
      request.log.error({ err }, "password reset email failed to send");
    }
  } else {
    // Spend comparable work on an address that does not exist. Without it the
    // response time separates known from unknown just as clearly as the body
    // would have.
    randomBytes(32);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }

  return reply.code(202).send({
    status: "accepted",
    message: "Wenn es zu dieser Adresse ein Konto gibt, ist eine E-Mail unterwegs.",
    // Development affordance so the flow is testable without a mail provider.
    ...(deps.revealLink && link ? { link } : {}),
  });
}

/**
 * Completes a reset.
 *
 * Three things happen together, and the order matters:
 *
 * The token is claimed atomically, so one link cannot reset a password twice
 * and two concurrent uses cannot both win.
 *
 * A second factor, where the account has one, is still required. Otherwise
 * reset is a way around MFA: control of an inbox would be enough to take an
 * owner account, and § 10.3 exists precisely because a single stolen credential
 * should not be.
 *
 * Every session is revoked. Someone resetting a password usually believes
 * another person has their account, and leaving that person signed in would
 * defeat the exercise.
 */
export async function handleResetConfirm(
  deps: ResetDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const body = (request.body ?? {}) as {
    token?: string;
    password?: string;
    totpCode?: string;
  };
  const token = typeof body.token === "string" ? body.token : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!token || !password) {
    return reply.code(400).send({ error: "token and password are required" });
  }

  // Hash the new password before claiming the token. If it is rejected for
  // being too short, the link is still usable - failing validation should not
  // cost the user their one link.
  let passwordHash: string;
  try {
    passwordHash = await hashPassword(password);
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }

  const tokenHash = hashToken(token);

  // Read the token without spending it: the second factor is checked first, so
  // a mistyped code does not cost the user their one link.
  const pending = await deps.db.withAdmin((client) => findPasswordReset(client, tokenHash));

  // Unknown, expired and already used are one answer.
  if (!pending) {
    return reply.code(400).send({ error: "invalid_or_expired_token" });
  }

  /*
   * Mirrors the login rule exactly, and deliberately so.
   *
   * Checking `mfaEnabled` alone leaves a hole: an owner created by setup has a
   * secret issued but the flag still off until their first sign-in confirms it.
   * During that window a reset would have asked for no second factor at all.
   * That is not a full takeover - login still refuses without the code - but it
   * lets whoever controls the inbox change the password and end every session,
   * which is a denial of service against the real owner.
   *
   * Any account that has a secret, or whose role requires one, must present a
   * code here.
   */
  const secondFactorRequired =
    Boolean(pending.totpSecret) || pending.mfaEnabled || requiresMfa(pending.role);

  if (secondFactorRequired) {
    if (!pending.totpSecret) {
      return reply.code(400).send({ error: "mfa_enrollment_required" });
    }
    if (!body.totpCode) {
      return reply.code(401).send({ error: "mfa_required" });
    }
    const result = verifyTotpStep(pending.totpSecret, body.totpCode);
    if (!result.valid || result.counter === undefined) {
      return reply.code(401).send({ error: "mfa_invalid" });
    }
    const consumed = await deps.db.withAdmin((client) =>
      consumeTotp(client, pending.userId, result.counter as number),
    );
    if (!consumed) {
      return reply.code(401).send({ error: "mfa_invalid" });
    }
  }

  // Now spend it. Atomic, so two concurrent uses of one link cannot both win,
  // and a link consumed between the read above and here loses here.
  const claim = await deps.db.withAdmin((client) => claimPasswordReset(client, tokenHash));
  if (!claim) {
    return reply.code(400).send({ error: "invalid_or_expired_token" });
  }

  await deps.db.withAdmin(async (client) => {
    await applyPasswordReset(client, claim.userId, passwordHash);
    await revokeSessionsForUser(client, claim.userId);
  });

  request.log.info({ userId: claim.userId }, "password reset completed");
  return reply.code(200).send({ status: "reset" });
}
