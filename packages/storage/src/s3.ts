import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import {
  ObjectStoreError,
  type ObjectInfo,
  type ObjectStore,
  type PutObjectInput,
  type PutObjectResult,
  type RetentionMode,
} from "./types.js";

export interface S3ObjectStoreOptions {
  bucket: string;
  region?: string;
  /** Set for MinIO or any non-AWS endpoint. */
  endpoint?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
  /** MinIO and most S3-compatible servers need path-style addressing. */
  forcePathStyle?: boolean;
  client?: S3Client;
}

function isConflict(err: unknown): boolean {
  const code = (err as { name?: string; Code?: string })?.name
    ?? (err as { Code?: string })?.Code;
  const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return code === "PreconditionFailed" || status === 412;
}

function isNotFound(err: unknown): boolean {
  const code = (err as { name?: string })?.name;
  const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return code === "NotFound" || code === "NoSuchKey" || status === 404;
}

/**
 * The WORM archive.
 *
 * Objects are written once, under an Object Lock retention that outlives the
 * statutory keeping period. Two details are doing the work:
 *
 * `IfNoneMatch: "*"` makes the write conditional, so a second delivery of the
 * same document is refused by the store rather than layered on as a new
 * version. Without it, versioning would quietly accept re-writes and the
 * "written once" claim would rest on application discipline.
 *
 * `ChecksumSHA256` has the server verify the digest we computed. If the bytes
 * are corrupted in transit the put fails, rather than succeeding and leaving an
 * object whose content no longer matches the hash in the Merkle tree.
 */
export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(options: S3ObjectStoreOptions) {
    this.bucket = options.bucket;
    this.client =
      options.client ??
      new S3Client({
        region: options.region ?? "eu-central-1",
        ...(options.endpoint ? { endpoint: options.endpoint } : {}),
        ...(options.credentials ? { credentials: options.credentials } : {}),
        forcePathStyle: options.forcePathStyle ?? Boolean(options.endpoint),
      } satisfies S3ClientConfig);
  }

  async put(input: PutObjectInput): Promise<PutObjectResult> {
    const checksum = Buffer.from(input.sha256, "hex").toString("base64");

    try {
      const response = await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: input.key,
          Body: input.bytes,
          ChecksumSHA256: checksum,
          ...(input.contentType ? { ContentType: input.contentType } : {}),
          ...(input.retention
            ? {
                ObjectLockMode: input.retention.mode,
                ObjectLockRetainUntilDate: input.retention.retainUntil,
              }
            : {}),
          IfNoneMatch: "*",
        }),
      );

      return {
        key: input.key,
        alreadyExisted: false,
        ...(response.VersionId ? { versionId: response.VersionId } : {}),
        ...(input.retention ? { retainUntil: input.retention.retainUntil } : {}),
      };
    } catch (err) {
      if (isConflict(err)) {
        // Content-addressed, so the existing object has identical bytes.
        const existing = await this.head(input.key);
        return {
          key: input.key,
          alreadyExisted: true,
          ...(existing?.versionId ? { versionId: existing.versionId } : {}),
          ...(existing?.retainUntil ? { retainUntil: existing.retainUntil } : {}),
        };
      }
      throw new ObjectStoreError(
        `Could not write ${input.key} to ${this.bucket}: ${(err as Error).message}`,
        input.key,
        err,
      );
    }
  }

  async get(key: string): Promise<Buffer> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const bytes = await response.Body?.transformToByteArray();
      if (!bytes) throw new Error("empty body");
      return Buffer.from(bytes);
    } catch (err) {
      throw new ObjectStoreError(
        `Could not read ${key} from ${this.bucket}: ${(err as Error).message}`,
        key,
        err,
      );
    }
  }

  async head(key: string): Promise<ObjectInfo | undefined> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        key,
        sizeBytes: response.ContentLength ?? 0,
        ...(response.VersionId ? { versionId: response.VersionId } : {}),
        ...(response.ObjectLockRetainUntilDate
          ? { retainUntil: response.ObjectLockRetainUntilDate }
          : {}),
        ...(response.ObjectLockMode
          ? { retentionMode: response.ObjectLockMode as RetentionMode }
          : {}),
      };
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw new ObjectStoreError(
        `Could not stat ${key} in ${this.bucket}: ${(err as Error).message}`,
        key,
        err,
      );
    }
  }
}
