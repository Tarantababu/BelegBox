import { loadTemplateDir } from "@belegbox/explain";
import { ConsoleEmailSender, PostmarkEmailSender, type EmailSender } from "@belegbox/mail";
import { Db, assertRlsEnforced, createPool } from "@belegbox/db";
import { buildApi } from "./server.js";
import { FilesystemObjectStore, S3ObjectStore, type ObjectStore } from "@belegbox/storage";

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

/**
 * Read access to the archive, for the Beleg bundle.
 *
 * Mirrors the worker's construction deliberately - the two processes have to
 * agree on where the originals are, and the environment is the one place that
 * agreement is written down.
 */
function buildObjectStore(): ObjectStore {
  const bucket = process.env["S3_BUCKET_RAW"];

  if (!bucket) {
    if (process.env["NODE_ENV"] === "production") {
      throw new Error(
        "S3_BUCKET_RAW is required in production. The filesystem store cannot enforce retention.",
      );
    }
    return new FilesystemObjectStore(process.env["INGEST_STORE_DIR"] ?? ".data/ingest/objects");
  }

  return new S3ObjectStore({
    bucket,
    region: process.env["S3_REGION"] ?? "eu-central-1",
    ...(process.env["S3_ENDPOINT"] ? { endpoint: process.env["S3_ENDPOINT"] } : {}),
    ...(process.env["S3_ACCESS_KEY_ID"] && process.env["S3_SECRET_ACCESS_KEY"]
      ? {
          credentials: {
            accessKeyId: process.env["S3_ACCESS_KEY_ID"],
            secretAccessKey: process.env["S3_SECRET_ACCESS_KEY"],
          },
        }
      : {}),
  });
}

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
  // The same environment the worker writes from, read here so the
  // Verfahrensdokumentation states the storage that is actually in use rather
  // than the one the document would like to describe.
  objectStore: buildObjectStore(),
  storage: {
    backend: process.env["S3_BUCKET_RAW"] ? "S3" : "Dateisystem",
    bucket: process.env["S3_BUCKET_RAW"] ?? (process.env["ARCHIVE_DIR"] ?? "lokales Verzeichnis"),
    objectLockMode: process.env["S3_BUCKET_RAW"]
      ? (process.env["S3_OBJECT_LOCK_MODE"] ?? "GOVERNANCE")
      : null,
    retentionYears: Number(process.env["RETENTION_YEARS"] ?? 10),
  },
  // Never in production: the link is the credential.
  revealResetLink:
    process.env["NODE_ENV"] !== "production" && process.env["REVEAL_RESET_LINK"] === "true",
});

await app.listen({ port: Number(process.env["PORT"] ?? 8082), host: "0.0.0.0" });
