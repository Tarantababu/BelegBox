#!/usr/bin/env node
import { Db, createPool } from "./client.js";
import { assertRlsEnforced, RlsBypassError } from "./guard.js";
import { migrate } from "./migrate.js";

/**
 * Prepares a managed database for Belegbox, in the order the migrations
 * actually require.
 *
 * The order is the point. Migration 0002 grants privileges to `belegbox_app`,
 * so the role has to exist before the migrations run - not after, which is what
 * the deployment notes used to say and what fails on a virgin database with
 * `role "belegbox_app" does not exist`. Locally that never showed up, because
 * the role was already there from the Docker init script or a test run.
 *
 * What this does, as the database owner:
 *
 *   1. creates or updates the application role
 *   2. grants it connect and schema usage
 *   3. runs the migrations, which grant the per-table privileges - including
 *      the deliberate absence of UPDATE and DELETE on the append-only tables
 *   4. connects *as that role* and proves it cannot step around Row Level
 *      Security, and that the archive refuses to be rewritten
 *
 * Step 4 is the one worth having. Everything before it can succeed while the
 * result is still wrong - an owner-owned connection, a BYPASSRLS grant added to
 * unblock something - and tenant isolation would then be off with nothing
 * saying so.
 */

const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("DATABASE_URL is required: the database owner's connection string.");
  process.exit(2);
}

const password = process.env["APP_DB_PASSWORD"];
if (!password) {
  // No default. A default here is how 'belegbox' reaches production, and the
  // role it protects is the one holding every tenant's invoices.
  console.error(
    "APP_DB_PASSWORD is required. Generate one and keep it in the secret store:\n" +
      "  node -e \"console.log(require('crypto').randomBytes(24).toString('base64url'))\"",
  );
  process.exit(2);
}
if (password.length < 16) {
  console.error("APP_DB_PASSWORD is too short; use at least 16 characters.");
  process.exit(2);
}

const APP_ROLE = "belegbox_app";

function databaseName(connectionString: string): string {
  const path = new URL(connectionString).pathname.replace(/^\//, "");
  if (!path) throw new Error("DATABASE_URL names no database.");
  return path;
}

const database = databaseName(url);
const owner = new Db(
  createPool(url, { max: 2, applicationName: "belegbox-provision", statementTimeoutMs: 0 }),
);

try {
  await owner.withAdmin(async (client) => {
    const { rows: existing } = await client.query<{ n: string }>(
      "SELECT count(*) AS n FROM pg_roles WHERE rolname = $1",
      [APP_ROLE],
    );

    if (Number(existing[0]?.n ?? 0) > 0) {
      // Already there. On a managed platform the role is created by the
      // provider - Fly's Managed Postgres, for one, creates it and refuses
      // `ALTER ROLE ... PASSWORD` outright, because passwords are theirs to
      // issue. Taking it as given is correct; the checks at the end still
      // decide whether it is usable.
      console.log(`  role       ${APP_ROLE} already exists, left as it is`);
    } else {
      // Quoted as a literal, not interpolated into the statement text: the
      // password comes from an environment variable and a quote in it would
      // otherwise end the string and run whatever follows.
      const quoted = await client.query<{ literal: string }>(
        "SELECT quote_literal($1) AS literal",
        [password],
      );
      await client.query(
        `CREATE ROLE ${APP_ROLE} LOGIN PASSWORD ${quoted.rows[0]?.literal as string}`,
      );
      console.log(`  role       ${APP_ROLE} created`);
    }

    // Never NOSUPERUSER/NOBYPASSRLS as an afterthought - assert it instead,
    // below, where a wrong answer stops the deployment.
    await client.query(`GRANT CONNECT ON DATABASE "${database}" TO ${APP_ROLE}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);

    const { applied, skipped } = await migrate(client);
    for (const name of skipped) console.log(`  =          ${name}`);
    for (const name of applied) console.log(`  +          ${name}`);
    console.log(
      applied.length > 0
        ? `  migrations ${applied.length} applied`
        : "  migrations already up to date",
    );
  });

  // Now prove it, as the role the application will actually use.
  const appUrl = new URL(url);
  appUrl.username = APP_ROLE;
  appUrl.password = password;

  const app = new Db(createPool(appUrl.toString(), { max: 2, applicationName: "belegbox-verify" }));
  try {
    await assertRlsEnforced(app);
    console.log("  isolation  row level security is binding on this connection");

    // The immutability guarantees, checked rather than assumed - and checked as
    // two different things, because they are two different things.
    //
    // An earlier version of this ran an UPDATE against each table and accepted
    // any error mentioning "append-only" as proof. The error it threw on
    // failure said "... it must be append-only", so its own catch matched it
    // and reported success. A check that cannot fail is worse than no check,
    // because it is also reassuring.
    await app.withAdmin(async (client) => {
      // Grant-level: these hold nothing but history, so the application role is
      // given INSERT and SELECT and nothing else. Read from the catalogue
      // rather than probed with a statement, so an empty table cannot pass by
      // matching no rows.
      const { rows: writable } = await client.query<{ table_name: string; privs: string }>(
        `SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
           FROM information_schema.role_table_grants
          WHERE grantee = $1
            AND table_name IN ('audit_log', 'archive_chain', 'verfahrensdokumentationen')
            AND privilege_type IN ('UPDATE', 'DELETE')
          GROUP BY table_name`,
        [APP_ROLE],
      );
      if (writable.length > 0) {
        throw new Error(
          `append-only broken: ${APP_ROLE} holds ${writable
            .map((row) => `${row.privs} on ${row.table_name}`)
            .join("; ")}`,
        );
      }

      // Trigger-level: `documents` is deliberately not append-only by grant -
      // the worker updates a document's status and verdict while processing it.
      // What must hold is that an archived row cannot be rewritten and no row
      // can be deleted, and that is enforced by triggers.
      const { rows: triggers } = await client.query<{ tgname: string; enabled: string }>(
        `SELECT tgname, tgenabled AS enabled
           FROM pg_trigger
          WHERE tgrelid = 'documents'::regclass AND NOT tgisinternal`,
      );
      const live = triggers.filter((row) => row.enabled !== "D").map((row) => row.tgname);
      for (const required of ["documents_archived_immutable", "documents_no_delete"]) {
        if (!live.includes(required)) {
          throw new Error(`archive immutability broken: trigger ${required} is missing or disabled`);
        }
      }
    });
    console.log("  archive    history append-only by grant, documents immutable by trigger");
  } finally {
    await app.close();
  }

  console.log("\nReady. Point the API and worker at:");
  console.log(`  DATABASE_URL=postgres://${APP_ROLE}:<APP_DB_PASSWORD>@${appUrl.host}/${database}`);
  console.log("Use the provider's pooled endpoint for that URL where there is one.");
} catch (err) {
  if (err instanceof RlsBypassError) {
    console.error(
      `\nRefusing to finish: ${err.message}\n` +
        `${APP_ROLE} must not be a superuser, must not hold BYPASSRLS, and must not own the tables.`,
    );
  } else {
    console.error(`\nProvisioning failed: ${(err as Error).message}`);
  }
  process.exitCode = 1;
} finally {
  await owner.close();
}
