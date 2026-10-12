/**
 * The tenant's tunable thresholds (SPINE-CONTRACT s.1.10).
 *
 * A threshold is typed by its unit: a currency threshold is bigint paise in
 * `valueMinor`, every other unit is a whole number in `valueInt`. The database
 * CHECK (20261013160000_threshold_minor) holds that split for every writer; this
 * module holds it for the admin write, so a refused shape gets a 400 rather than
 * a constraint error.
 *
 * A reader that needs a row which is not there refuses with a typed 409. It does
 * not fall back to a literal: a figure in the code that the tenant cannot see or
 * change is the thing the table exists to stop.
 */

import { z } from 'zod';
import { EVENTS, isCurrencyUnit } from '@kaizen/shared';
import { prisma } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { ApiError } from '../platform/errors.js';
import { assertCan } from '../platform/permissions.js';
import { auditWrite, registerGovernedEntities } from '../platform/audit.js';
import { emit } from '../platform/eventBus.js';
import { governedWrite } from '../platform/governedWrite.js';

registerGovernedEntities('org', ['threshold']);

/** Postgres BIGINT ceiling, so a paise value that the column cannot hold is refused here. */
const INT64_MAX = 9223372036854775807n;

/** Non-negative whole paise as a digit string. A JavaScript number is refused: it has already been rounded. */
const PAISE_TEXT = /^(0|[1-9]\d*)$/;

const PatchSchema = z.union([
  z.object({ valueMinor: z.string().regex(PAISE_TEXT) }).strict(),
  z.object({ valueInt: z.number().int().min(0).max(2_147_483_647) }).strict(),
]);

export async function findThreshold(key: string) {
  const auth = currentAuth();
  return prisma.threshold.findFirst({ where: { tenantId: auth.tenantId, thresholdKey: key } });
}

/** The 409 a reader raises when its threshold row is absent: a typed refusal, never a literal. */
export function missingThreshold(key: string): ApiError {
  return ApiError.conflict(`The threshold ${key} is not set for this tenant.`, { thresholdKey: key });
}

/** Writes a threshold's typed value. Assert, then write, audit and emit in one transaction. */
export async function setThreshold(key: string, body: unknown) {
  await assertCan({ resource: 'policies', verb: 'edit' });

  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    throw ApiError.badRequest(
      'A threshold takes valueMinor (whole paise, as a digit string) for a currency unit, or valueInt (a whole number) for any other unit.',
    );
  }

  const auth = currentAuth();
  return governedWrite(async (tx) => {
    const before = await tx.threshold.findFirst({ where: { tenantId: auth.tenantId, thresholdKey: key } });
    if (!before) throw ApiError.notFound('Threshold');

    const currency = isCurrencyUnit(before.unit);
    const minor = 'valueMinor' in parsed.data ? BigInt(parsed.data.valueMinor) : null;
    if (currency !== (minor !== null)) {
      throw ApiError.badRequest(
        `${key} is a ${before.unit} threshold and takes ${currency ? 'valueMinor' : 'valueInt'}.`,
      );
    }
    if (minor !== null && minor > INT64_MAX) {
      throw ApiError.badRequest('The amount is above the largest value the ledger stores.');
    }
    const data = minor !== null ? { valueMinor: minor } : { valueInt: (parsed.data as { valueInt: number }).valueInt };

    const after = await tx.threshold.update({ where: { id: before.id }, data });

    // Audit and event carry the value as a string: a BigInt in a JSON payload
    // would throw, and a number would be the float this column exists to avoid.
    const snapshot = (t: { valueMinor: bigint | null; valueInt: number | null }) => ({
      valueMinor: t.valueMinor?.toString() ?? null,
      valueInt: t.valueInt,
    });
    await auditWrite({
      action: 'update',
      subjectType: 'threshold',
      subjectId: before.id,
      before: { thresholdKey: key, unit: before.unit, ...snapshot(before) },
      after: { thresholdKey: key, unit: after.unit, ...snapshot(after) },
      tx,
    });
    await emit({
      name: EVENTS.THRESHOLD_UPDATED,
      subject: { entityType: 'threshold', entityId: before.id },
      previousState: snapshot(before),
      newState: snapshot(after),
      impact: { domains: ['org'] },
      tx,
    });
    return after;
  });
}
