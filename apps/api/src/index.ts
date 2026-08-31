import { Db, createPool } from "@belegbox/db";
import { buildApi } from "./server.js";

const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("DATABASE_URL is required. See .env.example.");
  process.exit(2);
}

const db = new Db(createPool(url));

const app = await buildApi({
  db,
  logger: true,
  // Placeholder until API keys and sessions land in F1 week 4-5. Deliberately
  // header-driven and deliberately obvious, so it cannot be mistaken for auth.
  resolveTenant: async (request) => {
    const header = request.headers["x-belegbox-tenant"];
    return typeof header === "string" ? header : undefined;
  },
});

await app.listen({ port: Number(process.env["PORT"] ?? 8082), host: "0.0.0.0" });
