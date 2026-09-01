import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /**
     * One test file at a time.
     *
     * Every suite here bootstraps the same database: it creates or alters the
     * `belegbox_app` role and runs the migrations. Two files doing that in
     * parallel workers race on the same catalog rows, and PostgreSQL answers
     * `tuple concurrently updated` - which surfaces as a suite that silently
     * skips rather than as anything that looks like a lock. It flaked about
     * half the time once a second DB test file existed.
     *
     * Sharing one bootstrap across files would be the other fix, and would cost
     * the isolation that lets each suite own its tenants.
     */
    fileParallelism: false,
  },
});
