import { loadTemplateDir } from "@belegbox/explain";
import { Db, createPool } from "@belegbox/db";
import { buildApi } from "./server.js";

const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("DATABASE_URL is required. See .env.example.");
  process.exit(2);
}

const db = new Db(createPool(url));
const explain = await loadTemplateDir();

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
  // Placeholder until API keys and sessions land. Deliberately header-driven
  // and deliberately obvious, so it cannot be mistaken for authentication.
  resolveTenant: async (request) => {
    const header = request.headers["x-belegbox-tenant"];
    return typeof header === "string" ? header : undefined;
  },
});

await app.listen({ port: Number(process.env["PORT"] ?? 8082), host: "0.0.0.0" });
