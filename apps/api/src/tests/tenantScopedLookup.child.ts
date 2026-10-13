/**
 * Child process for tenantScopedLookup.test.ts (FX-51).
 *
 * Runs with PRISMA_LOG=query so the SQL Prisma sends to Postgres is printed to
 * stdout, where the parent test can read it. The lookup is made under one
 * tenant's context for an id that belongs to nobody in that tenant, the case
 * the extension's fetch-then-check path existed for. Nothing here is mocked.
 */

import { runWithContext, systemContext } from '../platform/context.js';
import { prisma } from '../platform/db.js';

async function main(): Promise<void> {
  const tenantId = process.env.PROBE_TENANT_ID ?? '';
  const foreignId = process.env.PROBE_FOREIGN_ID ?? '';
  // The awaited call sits inside the async callback: a Prisma call is lazy, so
  // returning it unawaited would run it after the context has been left.
  const row = await runWithContext(systemContext(tenantId), async () =>
    prisma.person.findUnique({ where: { id: foreignId }, select: { fullName: true } }),
  );
  console.log(`PROBE-RESULT ${JSON.stringify(row)}`);
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error('PROBE-FAILED', err);
    process.exit(1);
  },
);
