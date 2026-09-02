import { readFile } from "node:fs/promises";
import { Db, assertRlsEnforced, createPool } from "@belegbox/db";
import { loadRuleSet, type RuleSet } from "@belegbox/rules-engine";
import { FilesystemObjectStore, S3ObjectStore, type ObjectStore } from "@belegbox/storage";
import { MustangClient } from "@belegbox/validation";
import { PostgresDocumentStore } from "./postgres-store.js";
import { buildServer } from "./server.js";
import { FilesystemDocumentStore, type DocumentStore } from "./store.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required. See .env.example.`);
  }
  return value;
}

/**
 * Chooses where raw documents land.
 *
 * The filesystem store exists for development and refuses to be used in
 * production: nothing on a local disk enforces retention, and an archive whose
 * immutability rests on nobody running `rm` is not an archive.
 */
function buildObjectStore(): ObjectStore {
  const bucket = process.env["S3_BUCKET_RAW"];

  if (!bucket) {
    if (process.env["NODE_ENV"] === "production") {
      throw new Error(
        "S3_BUCKET_RAW is required in production. The filesystem store cannot enforce retention, " +
          "and GoBD Unveraenderbarkeit is not satisfied by a directory.",
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

async function main(): Promise<void> {
  const provider = process.env["INGEST_PROVIDER"] ?? "postmark";
  const storeDir = process.env["INGEST_STORE_DIR"] ?? ".data/ingest";
  const port = Number(process.env["PORT"] ?? 8080);

  // COMPLIANCE cannot be lifted by anyone once set, so it is opt-in by
  // configuration and production sets it. Defaulting to it would make a
  // development mistake permanent.
  const retentionMode = process.env["S3_OBJECT_LOCK_MODE"] === "COMPLIANCE"
    ? "COMPLIANCE" as const
    : "GOVERNANCE" as const;

  const objects = buildObjectStore();
  const retentionYears = Number(process.env["RETENTION_YEARS"] ?? 10);
  const databaseUrl = process.env["DATABASE_URL"];

  let store: DocumentStore;
  let db: Db | undefined;

  if (databaseUrl) {
    db = new Db(createPool(databaseUrl));
    // Serving or writing tenant data over a connection that bypasses RLS is the
    // worst failure this system has, and it looks entirely normal from outside.
    await assertRlsEnforced(db);

    let ruleSet: RuleSet | undefined;
    if (process.env["RULESET_FILE"]) {
      ruleSet = loadRuleSet(await readFile(process.env["RULESET_FILE"], "utf8"));
    } else {
      // See the same note in apps/api: a missing rule set is a quieter,
      // weaker pipeline rather than a visible failure, so it is announced.
      console.warn("ruleset    none - L4 tenant rules will NOT run");
    }

    store = new PostgresDocumentStore({
      db,
      objects,
      retentionMode,
      retentionYears,
      // Without a validator the form verdict stays unknown. That is the honest
      // answer, and receiving keeps working while the JVM is down.
      ...(process.env["MUSTANG_SVC_URL"]
        ? { mustang: new MustangClient({ baseUrl: process.env["MUSTANG_SVC_URL"] }) }
        : {}),
      ...(ruleSet ? { ruleSet } : {}),
    });
  } else {
    if (process.env["NODE_ENV"] === "production") {
      throw new Error("DATABASE_URL is required in production.");
    }
    store = new FilesystemDocumentStore(storeDir, { objects, retentionMode, retentionYears });
  }

  const app = await buildServer({
    store,
    logger: true,
    ...(provider === "postmark"
      ? {
          postmark: {
            webhookUser: required("POSTMARK_WEBHOOK_USER"),
            webhookPassword: required("POSTMARK_WEBHOOK_PASSWORD"),
          },
        }
      : {}),
    ...(provider === "mailgun"
      ? { mailgun: { signingKey: required("MAILGUN_SIGNING_KEY") } }
      : {}),
  });

  await app.listen({ port, host: "0.0.0.0" });
  app.log.info(
    {
      provider,
      objectStore: objects.constructor.name,
      metadataStore: store.constructor.name,
      retentionMode,
      bucket: process.env["S3_BUCKET_RAW"] ?? null,
      ruleset: process.env["RULESET_FILE"] ?? null,
    },
    "ingest worker ready",
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
