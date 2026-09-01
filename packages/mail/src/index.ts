export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  send(email: OutboundEmail): Promise<void>;
}

/**
 * Development sender.
 *
 * Prints the message instead of delivering it, and says so loudly. A silent
 * no-op sender is how a reset flow reaches staging looking like it works.
 */
export class ConsoleEmailSender implements EmailSender {
  async send(email: OutboundEmail): Promise<void> {
    console.log(
      [
        "",
        "--- email not sent (ConsoleEmailSender) ------------------------------",
        `to      ${email.to}`,
        `subject ${email.subject}`,
        "",
        email.text,
        "----------------------------------------------------------------------",
        "",
      ].join("\n"),
    );
  }
}

export interface PostmarkSenderOptions {
  token: string;
  from: string;
  /** Postmark message stream. Transactional mail must not go out on a broadcast stream. */
  stream?: string;
  fetchImpl?: typeof fetch;
}

export class EmailDeliveryError extends Error {
  constructor(message: string, readonly to: string) {
    super(message);
    this.name = "EmailDeliveryError";
  }
}

/**
 * Postmark transactional sender.
 *
 * The recipient is never interpolated into anything but the API payload, and
 * the body is plain text: a reset mail with HTML is a reset mail with a
 * rendering surface, and it buys nothing.
 */
export class PostmarkEmailSender implements EmailSender {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: PostmarkSenderOptions) {
    if (!options.token) throw new Error("PostmarkEmailSender requires a server token.");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async send(email: OutboundEmail): Promise<void> {
    const response = await this.fetchImpl("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "X-Postmark-Server-Token": this.options.token,
      },
      body: JSON.stringify({
        From: this.options.from,
        To: email.to,
        Subject: email.subject,
        TextBody: email.text,
        MessageStream: this.options.stream ?? "outbound",
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      // The message is for our logs. The caller must not pass it to the user:
      // "no such recipient" would turn a reset request into an enumeration
      // oracle by another route.
      throw new EmailDeliveryError(
        `Postmark responded ${response.status}: ${(await response.text()).slice(0, 200)}`,
        email.to,
      );
    }
  }
}
