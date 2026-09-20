import { defineConfig } from 'vitest/config';

/**
 * The acceptance suite runs against a real database inside real request
 * contexts — a mocked permission check proves nothing about the one that runs
 * in production. It therefore gets a database of its own: the tests create and
 * mutate records, and the development dataset is a demonstration, not a
 * scratchpad. `scripts/test-db.sh` provisions it.
 *
 * Serial by construction. Several requirements — gapless record codes,
 * hash-chain continuity, the expiry ladder's per-rung idempotence — are claims
 * about ordering, and a parallel runner would be asserting something else.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    sequence: { concurrent: false },
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        'postgresql://kaizen:kaizen@127.0.0.1:5432/kaizen_test?schema=public',
      NODE_ENV: 'test',
      // Not a fallback: the API has none any more, so the suite supplies its
      // own. Long enough to satisfy the same rule production is held to.
      JWT_SECRET: 'test-only-secret-not-used-anywhere-else-0123456789',
      JOBS_ENABLED: 'false',
    },
  },
});
