import { FilesystemObjectStore, S3ObjectStore, type ObjectStore } from "@belegbox/storage";
import { buildServer } from "./server.js";
import { FilesystemDocumentStore } from "./store.js";

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
  const app = await buildServer({
    store: new FilesystemDocumentStore(storeDir, {
      objects,
      retentionMode,
      retentionYears: Number(process.env["RETENTION_YEARS"] ?? 10),
    }),
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
      retentionMode,
      bucket: process.env["S3_BUCKET_RAW"] ?? null,
    },
    "ingest worker ready",
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
