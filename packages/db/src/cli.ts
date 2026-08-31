#!/usr/bin/env node
import { Db, createPool } from "./client.js";
import { migrate } from "./migrate.js";

const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("DATABASE_URL is required. See .env.example.");
  process.exit(2);
}

const db = new Db(createPool(url, 2));
try {
  const { applied, skipped } = await db.withAdmin((client) => migrate(client));
  for (const name of skipped) console.log(`  = ${name}`);
  for (const name of applied) console.log(`  + ${name}`);
  console.log(
    applied.length > 0 ? `${applied.length} migration(s) applied.` : "Already up to date.",
  );
} finally {
  await db.close();
}
