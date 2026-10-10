/**
 * A Postgres-backed store for express-rate-limit.
 *
 * The in-memory limiters this replaces counted per process. Behind a second
 * API instance, or after a restart, a credential-stuffing run started again
 * from zero. Counting in a row that every instance increments in one statement
 * makes the limit hold across them.
 *
 * The window is measured on the database clock (`now()`), not on each
 * instance's clock, so two instances with drifting clocks agree on when a
 * window opens. Keys carry no tenant (see RateLimitBucket in
 * prisma/schema/platform.prisma): a limit on an unauthenticated request must
 * bite before a tenant is known.
 */

import type { ClientRateLimitInfo, Options, Store } from 'express-rate-limit';
import { unscopedPrisma } from './db.js';

export class PostgresRateLimitStore implements Store {
  private windowMs = 60_000;

  /**
   * express-rate-limit reads `prefix` to tell two stores' keys apart when it
   * checks a single request is not counted twice. Two limiters on the same
   * address would otherwise look like one double-counted limiter.
   */
  readonly prefix: string;

  /** @param name namespaces keys so two limiters never share a counter. */
  constructor(name: string) {
    this.prefix = `${name}:`;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    // One statement, so two requests arriving together cannot both read the
    // same count and both write count + 1. When the window has lapsed the
    // counter starts again at 1 in the same write.
    const rows = await unscopedPrisma.$queryRawUnsafe<{ hits: number; resetAt: Date }[]>(
      `INSERT INTO "RateLimitBucket" ("key", "hits", "windowStart")
       VALUES ($1, 1, now())
       ON CONFLICT ("key") DO UPDATE SET
         "hits" = CASE WHEN "RateLimitBucket"."windowStart" <= now() - ($2::int * interval '1 millisecond')
                       THEN 1 ELSE "RateLimitBucket"."hits" + 1 END,
         "windowStart" = CASE WHEN "RateLimitBucket"."windowStart" <= now() - ($2::int * interval '1 millisecond')
                              THEN now() ELSE "RateLimitBucket"."windowStart" END
       RETURNING "hits", "windowStart" + ($2::int * interval '1 millisecond') AS "resetAt"`,
      this.bucketKey(key),
      this.windowMs,
    );
    const row = rows[0]!;
    return { totalHits: Number(row.hits), resetTime: new Date(row.resetAt) };
  }

  async decrement(key: string): Promise<void> {
    await unscopedPrisma.$executeRawUnsafe(
      `UPDATE "RateLimitBucket" SET "hits" = GREATEST("hits" - 1, 0) WHERE "key" = $1`,
      this.bucketKey(key),
    );
  }

  async resetKey(key: string): Promise<void> {
    await unscopedPrisma.$executeRawUnsafe(`DELETE FROM "RateLimitBucket" WHERE "key" = $1`, this.bucketKey(key));
  }

  private bucketKey(key: string): string {
    return `${this.prefix}${key}`;
  }
}
