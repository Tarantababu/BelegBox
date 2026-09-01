import { describe, expect, it, vi } from "vitest";
import { EmailDeliveryError, PostmarkEmailSender } from "./index.js";

const email = { to: "user@example.test", subject: "Hallo", text: "Inhalt" };

describe("PostmarkEmailSender", () => {
  it("posts a plain-text transactional message", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    await new PostmarkEmailSender({
      token: "token",
      from: "no-reply@belegbox.de",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).send(email);

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["To"]).toBe(email.to);
    expect(body["TextBody"]).toBe(email.text);
    // Plain text only: a reset mail with HTML is a reset mail with a rendering
    // surface, and it buys nothing.
    expect(body["HtmlBody"]).toBeUndefined();
    // Transactional mail must not go out on a broadcast stream.
    expect(body["MessageStream"]).toBe("outbound");
    expect((init.headers as Record<string, string>)["X-Postmark-Server-Token"]).toBe("token");
  });

  it("raises on a rejected send so the caller can log it", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("no such recipient", { status: 422 }));
    const sender = new PostmarkEmailSender({
      token: "token",
      from: "no-reply@belegbox.de",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    // The caller swallows this: surfacing "no such recipient" to the user would
    // turn a reset request into an enumeration oracle by another route.
    await expect(sender.send(email)).rejects.toThrow(EmailDeliveryError);
  });

  it("refuses to construct without a token", () => {
    expect(() => new PostmarkEmailSender({ token: "", from: "x@y.de" })).toThrow();
  });
});
