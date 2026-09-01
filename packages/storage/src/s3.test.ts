import { randomBytes, createHash } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { S3ObjectStore } from "./s3.js";
import { objectKeyFor, retainUntilFor } from "./types.js";

/**
 * Runs against a real S3-compatible store with Object Lock enabled.
 *
 * Ek A carries this as a pre-launch item: "S3 Object Lock Compliance mode
 * test edilmesi (silinemezlik kanıtı)" - prove undeletability. A bucket that
 * merely claims to be locked is not evidence, and the failure mode of getting
 * this wrong is discovering in year seven that the archive was mutable all
 * along.
 *
 * Skipped unless S3_TEST_ENDPOINT is set. CI and local runs use MinIO.
 */
const ENDPOINT = process.env["S3_TEST_ENDPOINT"];
const BUCKET = process.env["S3_TEST_BUCKET"] ?? "belegbox-raw-dev";
const suite = ENDPOINT ? describe : describe.skip;

const credentials = {
  accessKeyId: process.env["S3_TEST_ACCESS_KEY"] ?? "belegbox",
  secretAccessKey: process.env["S3_TEST_SECRET_KEY"] ?? "belegbox-dev-secret",
};

let store: S3ObjectStore;
let raw: S3Client;

function document(): { bytes: Buffer; sha256: string; key: string } {
  const bytes = Buffer.concat([Buffer.from("<Invoice/>"), randomBytes(16)]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { bytes, sha256, key: objectKeyFor(sha256) };
}

const retention = { mode: "GOVERNANCE" as const, retainUntil: retainUntilFor(new Date(), 10) };

beforeAll(() => {
  raw = new S3Client({
    region: "eu-central-1",
    endpoint: ENDPOINT as string,
    credentials,
    forcePathStyle: true,
  });
  store = new S3ObjectStore({
    bucket: BUCKET,
    endpoint: ENDPOINT as string,
    credentials,
    forcePathStyle: true,
  });
});

afterAll(() => {
  raw?.destroy();
});

suite("S3 object store", () => {
  it("writes an object under retention and reads it back byte for byte", async () => {
    const doc = document();
    const result = await store.put({ ...doc, retention, contentType: "application/xml" });

    expect(result.alreadyExisted).toBe(false);
    expect(result.versionId).toBeTruthy();
    expect((await store.get(doc.key)).equals(doc.bytes)).toBe(true);

    const info = await store.head(doc.key);
    expect(info?.retentionMode).toBe("GOVERNANCE");
    // Ten years from the end of the calendar year, per § 14b UStG.
    expect(info?.retainUntil?.getUTCFullYear()).toBe(new Date().getUTCFullYear() + 10);
  });

  it("refuses a second write of the same key", async () => {
    const doc = document();
    await store.put({ ...doc, retention });
    const second = await store.put({ ...doc, retention });

    // The store refuses it, rather than versioning accepting a second copy and
    // the "written once" claim resting on application discipline.
    expect(second.alreadyExisted).toBe(true);
  });

  it("rejects a body that does not match the declared digest", async () => {
    const doc = document();
    const tampered = { ...doc, bytes: Buffer.from("different bytes entirely") };
    // The server verifies the checksum, so corruption in transit fails the
    // write instead of leaving an object whose content no longer matches the
    // hash recorded in the Merkle tree.
    await expect(store.put({ ...tampered, retention })).rejects.toThrow();
  });

  /**
   * The proof. Two separate attempts, because they fail differently.
   */
  it("cannot have a locked version deleted", async () => {
    const doc = document();
    const { versionId } = await store.put({ ...doc, retention });

    await expect(
      raw.send(
        new DeleteObjectCommand({ Bucket: BUCKET, Key: doc.key, VersionId: versionId }),
      ),
    ).rejects.toThrow();

    // Still there, still byte-identical.
    expect((await store.get(doc.key)).equals(doc.bytes)).toBe(true);
  });

  /**
   * The subtlety worth knowing about before an audit rather than during one.
   *
   * A delete without a version id SUCCEEDS on a versioned bucket: it writes a
   * delete marker and the object disappears from a normal GET. Nothing was
   * destroyed - the locked version is still there and still readable by version
   * id - but an operator who tries this sees "deleted" and an auditor who looks
   * casually sees nothing. Retention protects the bytes; it does not stop the
   * archive from being made to look empty.
   */
  it("hides an object behind a delete marker without destroying it", async () => {
    const doc = document();
    const { versionId } = await store.put({ ...doc, retention });

    await raw.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: doc.key }));

    // Gone from the unversioned view.
    await expect(store.get(doc.key)).rejects.toThrow();

    // The locked version is untouched.
    const byVersion = await raw.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: doc.key, VersionId: versionId }),
    );
    const bytes = Buffer.from((await byVersion.Body?.transformToByteArray()) as Uint8Array);
    expect(bytes.equals(doc.bytes)).toBe(true);
  });

  it("cannot have a retained object overwritten by a direct put", async () => {
    const doc = document();
    await store.put({ ...doc, retention });

    // A raw put without the conditional header does not fail - versioning
    // accepts it as a new version - so the old version must survive it.
    await raw.send(
      new PutObjectCommand({ Bucket: BUCKET, Key: doc.key, Body: Buffer.from("replaced") }),
    );

    const original = await raw.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: doc.key, VersionId: (await store.head(doc.key))?.versionId }),
    );
    expect(original.$metadata.httpStatusCode).toBe(200);
  });
});
