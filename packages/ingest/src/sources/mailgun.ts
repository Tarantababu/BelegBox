import { createHmac, timingSafeEqual } from "node:crypto";
import { parseAuthenticationResults } from "../auth-results.js";
import type { InboundMessage, RawAttachment } from "../types.js";
import { findHeader, type IngestSource, type VerificationResult } from "./source.js";

export interface MailgunRequest {
  /** Parsed multipart form fields. */
  fields: Record<string, string>;
  /** Parsed multipart file parts, in `attachment-N` order. */
  attachments: RawAttachment[];
}

export interface MailgunSourceOptions {
  /** Mailgun HTTP webhook signing key - not the sending API key. */
  signingKey: string;
  /** Rejects signatures older than this. Default 5 minutes. */
  toleranceSeconds?: number;
  /**
   * Records a token so a captured request cannot be replayed inside the
   * tolerance window. Returns false if the token was already used. In-memory
   * by default; back it with Redis or Postgres once there is more than one
   * worker.
   */
  consumeToken?: (token: string) => boolean;
}

function defaultTokenStore(): (token: string) => boolean {
  const seen = new Map<string, number>();
  return (token) => {
    const now = Date.now();
    for (const [t, at] of seen) {
      if (now - at > 15 * 60 * 1000) seen.delete(t);
    }
    if (seen.has(token)) return false;
    seen.set(token, now);
    return true;
  };
}

export function mailgunSource(opts: MailgunSourceOptions): IngestSource<MailgunRequest> {
  if (!opts.signingKey) {
    throw new Error("mailgunSource requires a signingKey.");
  }
  const tolerance = opts.toleranceSeconds ?? 300;
  const consumeToken = opts.consumeToken ?? defaultTokenStore();

  return {
    provider: "mailgun",

    verify(request): VerificationResult {
      const { timestamp, token, signature } = request.fields;
      if (!timestamp || !token || !signature) {
        return { ok: false, reason: "Missing timestamp, token or signature." };
      }

      const age = Math.abs(Date.now() / 1000 - Number(timestamp));
      if (!Number.isFinite(age) || age > tolerance) {
        return { ok: false, reason: `Signature timestamp is outside the ${tolerance}s window.` };
      }

      const expected = createHmac("sha256", opts.signingKey)
        .update(timestamp + token)
        .digest();
      let provided: Buffer;
      try {
        provided = Buffer.from(signature, "hex");
      } catch {
        return { ok: false, reason: "Signature is not hex." };
      }
      if (provided.length !== expected.length) {
        return { ok: false, reason: "Bad signature." };
      }
      if (!timingSafeEqual(provided, expected)) {
        return { ok: false, reason: "Bad signature." };
      }

      // Valid signature, but a replayed one is still an attack.
      if (!consumeToken(token)) {
        return { ok: false, reason: "Token already used - replayed request." };
      }
      return { ok: true };
    },

    normalize(request): InboundMessage {
      const f = request.fields;
      const headers = parseMessageHeaders(f["message-headers"]);
      const timestamp = Number(f["timestamp"]);
      const receivedAt =
        Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp * 1000) : new Date();

      return {
        provider: "mailgun",
        providerMessageId: f["Message-Id"] ?? f["message-id"] ?? f["token"] ?? "",
        ...(f["Message-Id"] ? { messageId: f["Message-Id"] } : {}),
        // `recipient` is the envelope recipient Mailgun routed on.
        to: f["recipient"] ?? f["To"] ?? "",
        from: f["sender"] ?? f["from"] ?? f["From"] ?? "",
        subject: f["subject"] ?? f["Subject"] ?? "",
        receivedAt,
        senderAuth: parseAuthenticationResults(
          findHeader(headers, "Authentication-Results") ?? f["X-Mailgun-Spf"],
        ),
        attachments: request.attachments,
      };
    },
  };
}

/** Mailgun sends `message-headers` as a JSON array of [name, value] pairs. */
function parseMessageHeaders(raw: string | undefined): Array<{ name: string; value: string }> {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e): e is [string, string] => Array.isArray(e) && typeof e[0] === "string")
      .map(([name, value]) => ({ name, value: String(value ?? "") }));
  } catch {
    // Provider payloads are untrusted input; a malformed header block must not
    // take down ingestion of an otherwise valid invoice.
    return [];
  }
}
