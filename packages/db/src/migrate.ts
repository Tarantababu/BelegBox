import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { PoolClient } from "pg";

export const MIGRATIONS_DIR = join(import.meta.dirname, "../migrations");

export interface AppliedMigration {
  name: string;
  sha256: string;
  appliedAt: Date;
}

/**
 * Forward-only SQL migrations.
 *
 * Each file's digest is recorded. Editing a migration that has already run is
 * the classic way for two environments to drift apart while both claim to be up
 * to date, so it is refused outright rather than warned about.
 */
export async function migrate(
  client: PoolClient,
  dir = MIGRATIONS_DIR,
): Promise<{ applied: string[]; skipped: string[] }> {
  // Extensions the migrations themselves depend on. 0003 indexes with
  // gin_trgm_ops, so a fresh database without pg_trgm failed there - a long
  // way from anything that looks like a missing extension. Created here
  // because this function is the installer, and forward-only means the fix
  // cannot go into 0003 where the need first appears.
  await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
  await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");

  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      sha256     text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const { rows } = await client.query<{ name: string; sha256: string }>(
    "SELECT name, sha256 FROM schema_migrations",
  );
  const already = new Map(rows.map((r) => [r.name, r.sha256]));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const name of files) {
    const sql = await readFile(join(dir, name), "utf8");
    const sha256 = createHash("sha256").update(sql).digest("hex");
    const previous = already.get(name);

    if (previous) {
      if (previous !== sha256) {
        throw new Error(
          `Migration ${name} changed after it was applied (${previous.slice(0, 12)} -> ${sha256.slice(0, 12)}). Migrations are forward-only: add a new file instead.`,
        );
      }
      skipped.push(name);
      continue;
    }

    // One transaction per migration: a failure leaves the database on the last
    // complete migration rather than half-way through this one.
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)", [
        name,
        sha256,
      ]);
      await client.query("COMMIT");
      applied.push(name);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${name} failed: ${(err as Error).message}`, { cause: err });
    }
  }

  return { applied, skipped };
}
