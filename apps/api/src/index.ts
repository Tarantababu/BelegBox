import { loadTemplateDir } from "@belegbox/explain";
import { ConsoleEmailSender, PostmarkEmailSender, type EmailSender } from "@belegbox/mail";
import { Db, assertRlsEnforced, createPool } from "@belegbox/db";
import { buildApi } from "./server.js";

const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("DATABASE_URL is required. See .env.example.");
  process.exit(2);
}

const db = new Db(createPool(url));

// Before anything else. Serving tenant data over a connection that bypasses RLS
// is the worst failure this system has, and it looks completely normal from the
// outside - every screen renders, every number is plausible, and they belong to
// somebody else.
await assertRlsEnforced(db);

const explain = await loadTemplateDir();

// Postmark when configured, otherwise a sender that prints and says so. A
// silent no-op is how a reset flow reaches staging looking like it works.
const mail: EmailSender = process.env["POSTMARK_TOKEN"]
  ? new PostmarkEmailSender({
      token: process.env["POSTMARK_TOKEN"] as string,
      from: process.env["MAIL_FROM"] ?? "no-reply@belegbox.de",
    })
  : new ConsoleEmailSender();

const app = await buildApi({
  db,
  explain,
  logger: true,
  // Templates are unapproved until a lawyer reviews the wording (Ek A).
  // Production must leave this false; it is on outside production so the
  // screens can be built and reviewed before the gate is passed.
  allowUnapprovedTemplates: process.env["ALLOW_UNAPPROVED_TEMPLATES"] === "true",
  ...(process.env["INBOX_DOMAIN"] ? { inboxDomain: process.env["INBOX_DOMAIN"] } : {}),
  corsOrigins: (process.env["CORS_ORIGINS"] ?? "http://localhost:3000")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
  // Cookies are Secure unless explicitly told otherwise, which only local http
  // needs.
  secureCookies: process.env["INSECURE_COOKIES"] !== "true",
  mail,
  webUrl: process.env["WEB_URL"] ?? "http://localhost:3000",
  // Never in production: the link is the credential.
  revealResetLink:
    process.env["NODE_ENV"] !== "production" && process.env["REVEAL_RESET_LINK"] === "true",
});

await app.listen({ port: Number(process.env["PORT"] ?? 8082), host: "0.0.0.0" });
