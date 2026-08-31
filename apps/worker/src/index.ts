import { buildServer } from "./server.js";
import { FilesystemDocumentStore } from "./store.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required. See .env.example.`);
  }
  return value;
}

async function main(): Promise<void> {
  const provider = process.env["INGEST_PROVIDER"] ?? "postmark";
  const storeDir = process.env["INGEST_STORE_DIR"] ?? ".data/ingest";
  const port = Number(process.env["PORT"] ?? 8080);

  const app = await buildServer({
    store: new FilesystemDocumentStore(storeDir),
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
    { provider, storeDir },
    "ingest worker ready - documents land on the filesystem until week 2 swaps in S3 and Postgres",
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
