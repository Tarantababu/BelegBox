import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ObjectStoreError,
  type ObjectInfo,
  type ObjectStore,
  type PutObjectInput,
  type PutObjectResult,
} from "./types.js";

/**
 * Local stand-in for the WORM archive.
 *
 * Writes with the `wx` flag, so a second put of the same key fails rather than
 * overwriting - the same refusal S3 gives for a conditional write against an
 * existing object. Retention is recorded but not enforced: nothing on a local
 * filesystem can stop `rm`.
 *
 * That gap is the reason this is a development convenience and not a fallback.
 * Production runs against a Compliance-mode bucket, and the proof that the
 * bucket behaves is a test against a real S3, not against this.
 */
export class FilesystemObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}

  private path(key: string): string {
    return join(this.root, key);
  }

  async put(input: PutObjectInput): Promise<PutObjectResult> {
    const path = this.path(input.key);
    await mkdir(dirname(path), { recursive: true });

    try {
      await writeFile(path, input.bytes, { flag: "wx" });
      if (input.retention) {
        await writeFile(
          `${path}.retention.json`,
          JSON.stringify({
            mode: input.retention.mode,
            retainUntil: input.retention.retainUntil.toISOString(),
          }),
          { flag: "w" },
        );
      }
      return {
        key: input.key,
        alreadyExisted: false,
        ...(input.retention ? { retainUntil: input.retention.retainUntil } : {}),
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        return { key: input.key, alreadyExisted: true };
      }
      throw new ObjectStoreError(
        `Could not write ${input.key}: ${(err as Error).message}`,
        input.key,
        err,
      );
    }
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.path(key));
    } catch (err) {
      throw new ObjectStoreError(`Could not read ${key}: ${(err as Error).message}`, key, err);
    }
  }

  async head(key: string): Promise<ObjectInfo | undefined> {
    try {
      const info = await stat(this.path(key));
      let retainUntil: Date | undefined;
      try {
        const raw = JSON.parse(
          await readFile(`${this.path(key)}.retention.json`, "utf8"),
        ) as { retainUntil?: string };
        if (raw.retainUntil) retainUntil = new Date(raw.retainUntil);
      } catch {
        // No retention sidecar: an object written before retention was applied.
      }
      return { key, sizeBytes: info.size, ...(retainUntil ? { retainUntil } : {}) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new ObjectStoreError(`Could not stat ${key}: ${(err as Error).message}`, key, err);
    }
  }
}
