/**
 * RateLimitBucket retention: a bucket whose window ended more than a day ago
 * is dead weight, and the store never deleted one. Rate-limit counters are not
 * accounting or audit data, so removing them is safe; the day of grace is only
 * so that a bucket read during a clock skew between instances is not gone the
 * instant its window closes.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { unscopedPrisma } from './helpers.js';
import { purgeExpiredRateLimitBuckets } from '../platform/rateLimitStore.js';

const PREFIX = 'retention-test:';

async function insertBucket(suffix: string, windowStartSql: string): Promise<void> {
  await unscopedPrisma.$executeRawUnsafe(
    `INSERT INTO "RateLimitBucket" ("key", "hits", "windowStart")
     VALUES ($1, 3, ${windowStartSql})
     ON CONFLICT ("key") DO UPDATE SET "windowStart" = EXCLUDED."windowStart"`,
    `${PREFIX}${suffix}`,
  );
}

async function keysPresent(): Promise<string[]> {
  const rows = await unscopedPrisma.$queryRaw<{ key: string }[]>`
    SELECT key FROM "RateLimitBucket" WHERE key LIKE 'retention-test:%' ORDER BY key`;
  return rows.map((r) => r.key);
}

beforeEach(async () => {
  await unscopedPrisma.$executeRaw`DELETE FROM "RateLimitBucket" WHERE key LIKE 'retention-test:%'`;
});

describe('RateLimitBucket retention', () => {
  it('removes buckets whose window ended more than a day ago and keeps the rest', async () => {
    await insertBucket('long-dead', `now() - interval '3 days'`);
    await insertBucket('just-past-grace', `now() - interval '1 day 10 minutes'`);
    await insertBucket('inside-grace', `now() - interval '12 hours'`);
    await insertBucket('live', `now()`);

    await purgeExpiredRateLimitBuckets(60_000);

    expect(await keysPresent()).toEqual([`${PREFIX}inside-grace`, `${PREFIX}live`]);
  });

  it('measures the day from the window end, not its start', async () => {
    // Opened a day and 30s ago with a 60s window: it ended 30s after the
    // one-day mark, so it is inside the grace and must stay.
    await insertBucket('ended-after-mark', `now() - interval '1 day 30 seconds'`);
    // Opened a day and 2 minutes ago: it ended a minute before the mark, so it goes.
    await insertBucket('ended-before-mark', `now() - interval '1 day 2 minutes'`);

    await purgeExpiredRateLimitBuckets(60_000);

    expect(await keysPresent()).toEqual([`${PREFIX}ended-after-mark`]);
  });
});
