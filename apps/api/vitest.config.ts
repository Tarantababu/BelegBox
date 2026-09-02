import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /**
     * One test file at a time, for the same reason packages/db does it.
     *
     * `password-reset.test.ts` and `upload.test.ts` both bootstrap the database
     * by creating or altering the `belegbox_app` role. In parallel workers they
     * race on the same catalog rows and PostgreSQL answers `tuple concurrently
     * updated`, which arrives as a suite that failed to collect rather than as
     * anything resembling a lock.
     *
     * It appeared the moment a second database-backed file existed here, which
     * is exactly when it appeared in packages/db.
     */
    fileParallelism: false,
  },
});
