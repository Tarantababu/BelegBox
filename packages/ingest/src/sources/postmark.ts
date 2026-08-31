import { timingSafeEqual } from "node:crypto";
import { parseAuthenticationResults } from "../auth-results.js";
import type { InboundMessage, RawAttachment } from "../types.js";
import { findHeader, type IngestSource, type VerificationResult } from "./source.js";

/** The subset of Postmark's inbound payload this product uses. */
export interface PostmarkInboundPayload {
  MessageID?: string;
  Date?: string;
  From?: string;
  Subject?: string;
  MailboxHash?: string;
  OriginalRecipient?: string;
  To?: string;
  ToFull?: Array<{ Email?: string }>;
  Headers?: Array<{ Name: string; Value: string }>;
  Attachments?: Array<{
    Name?: string;
    Content?: string;
    ContentType?: string;
    ContentLength?: number;
  }>;
}

export interface PostmarkRequest {
  /** The raw `Authorization` header of the webhook request. */
  authorization?: string;
  payload: PostmarkInboundPayload;
}

export interface PostmarkSourceOptions {
  /**
   * Shared secret, sent by Postmark as HTTP Basic credentials embedded in the
   * webhook URL. Postmark does not sign inbound webhooks, so this plus TLS is
   * the whole authentication story - it must be a high-entropy value from the
   * secret store, never a memorable password.
   */
  webhookUser: string;
  webhookPassword: string;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (x.length !== y.length) {
    timingSafeEqual(x, x);
    return false;
  }
  return timingSafeEqual(x, y);
}

export function postmarkSource(
  opts: PostmarkSourceOptions,
): IngestSource<PostmarkRequest> {
  if (!opts.webhookUser || !opts.webhookPassword) {
    throw new Error("postmarkSource requires webhookUser and webhookPassword.");
  }

  return {
    provider: "postmark",

    verify(request): VerificationResult {
      const header = request.authorization ?? "";
      if (!header.toLowerCase().startsWith("basic ")) {
        return { ok: false, reason: "Missing HTTP Basic credentials." };
      }
      const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
      const sep = decoded.indexOf(":");
      if (sep < 0) return { ok: false, reason: "Malformed credentials." };

      const userOk = safeEqual(decoded.slice(0, sep), opts.webhookUser);
      const passOk = safeEqual(decoded.slice(sep + 1), opts.webhookPassword);
      // Both branches always evaluate, so the failure mode is not distinguishable.
      return userOk && passOk ? { ok: true } : { ok: false, reason: "Bad credentials." };
    },

    normalize(request): InboundMessage {
      const p = request.payload;
      const headers = (p.Headers ?? []).map((h) => ({ name: h.Name, value: h.Value }));

      const attachments: RawAttachment[] = (p.Attachments ?? [])
        .filter((a) => typeof a.Content === "string")
        .map((a) => ({
          filename: a.Name ?? "attachment",
          contentType: a.ContentType ?? "application/octet-stream",
          bytes: Buffer.from(a.Content ?? "", "base64"),
        }));

      const receivedAt = p.Date ? new Date(p.Date) : new Date();

      return {
        provider: "postmark",
        providerMessageId: p.MessageID ?? "",
        ...(findHeader(headers, "Message-ID")
          ? { messageId: findHeader(headers, "Message-ID") as string }
          : {}),
        // OriginalRecipient is the envelope recipient. `To` is a header the
        // sender controls, so it is only a fallback.
        to: p.OriginalRecipient ?? p.ToFull?.[0]?.Email ?? p.To ?? "",
        ...(p.MailboxHash ? { mailboxHash: p.MailboxHash } : {}),
        from: p.From ?? "",
        subject: p.Subject ?? "",
        receivedAt: Number.isNaN(receivedAt.getTime()) ? new Date() : receivedAt,
        senderAuth: parseAuthenticationResults(
          findHeader(headers, "Authentication-Results"),
        ),
        attachments,
      };
    },
  };
}
