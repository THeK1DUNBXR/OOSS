/**
 * The unified record-code generator (CRM-FOUND-007).
 *
 * `record_code = <TYPE>-<YYYY>-<NNNNN>`, allocated per tenant, per type, per
 * year, gapless within the year, generator-assigned at creation, never
 * caller-supplied, never editable afterwards.
 *
 * The atomic increment guarantees no two records receive the same sequence
 * under concurrency. Sequence exhaustion fails loudly rather than emitting a
 * duplicate or a malformed code.
 */

import { formatRecordCode, RECORD_CODE_MAX_SEQUENCE, type RecordTypeCode } from '@kaizen/shared';
import { prisma } from './db.js';
import { currentTenantId } from './context.js';
import { ApiError } from './errors.js';

export class SequenceExhaustedError extends Error {
  readonly code = 'RECORD_SEQUENCE_EXHAUSTED';
  constructor(type: string, year: number) {
    super(
      `Record-code sequence exhausted for ${type} in ${year} (max ${RECORD_CODE_MAX_SEQUENCE}). ` +
        'This is an operational alert condition, not a silent rollover.',
    );
  }
}

/**
 * Allocates the next code. Uses the same canonical timestamp source as the
 * event envelope's `occurredAt`, so a record created at the year boundary can
 * never have a code/event year mismatch.
 */
export async function nextRecordCode(type: RecordTypeCode, at: Date = new Date()): Promise<string> {
  const tenantId = currentTenantId();
  const year = at.getUTCFullYear();

  const row = await prisma.recordSequence.upsert({
    where: { tenantId_entityType_year: { tenantId, entityType: type, year } },
    create: { tenantId, entityType: type, year, nextSequence: 2 },
    update: { nextSequence: { increment: 1 } },
    select: { nextSequence: true },
  });

  // upsert returns the post-increment value on update and the created value on
  // create; the allocated sequence is one less in both cases.
  const seq = row.nextSequence - 1;

  if (seq > RECORD_CODE_MAX_SEQUENCE) throw new SequenceExhaustedError(type, year);
  return formatRecordCode(type, year, seq);
}

/** Allocates a batch atomically — used by seed and backfill paths. */
export async function nextRecordCodes(type: RecordTypeCode, count: number, at: Date = new Date()): Promise<string[]> {
  const tenantId = currentTenantId();
  const year = at.getUTCFullYear();

  const row = await prisma.recordSequence.upsert({
    where: { tenantId_entityType_year: { tenantId, entityType: type, year } },
    create: { tenantId, entityType: type, year, nextSequence: count + 1 },
    update: { nextSequence: { increment: count } },
    select: { nextSequence: true },
  });

  const end = row.nextSequence - 1;
  const start = end - count + 1;
  const codes: string[] = [];
  for (let s = start; s <= end; s += 1) {
    if (s > RECORD_CODE_MAX_SEQUENCE) throw new SequenceExhaustedError(type, year);
    codes.push(formatRecordCode(type, year, s));
  }
  return codes;
}

/**
 * `record_code` is rejected as an edit target for every role, including roles
 * holding a full edit grant on the record otherwise.
 */
export function rejectRecordCodeEdit(patch: Record<string, unknown>): void {
  if ('recordCode' in patch || 'record_code' in patch) {
    throw ApiError.unprocessable(
      'record_code is generator-assigned and immutable after creation. It is not an editable field for any role.',
    );
  }
}
