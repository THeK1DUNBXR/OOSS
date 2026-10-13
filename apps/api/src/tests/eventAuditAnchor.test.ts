/**
 * FX-24 cross-anchor. A governed write records an AuditRecord and an EventRecord, and each
 * event carries the id of its audit row (EventRecord.auditRecordId). The orphan verifier
 * reports an event whose anchor is missing or points at another subject, and a governed-write
 * audit row that no event points at. Every row here is created by its own test.
 */

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { EVENTS } from '@kaizen/shared';
import { auditWrite } from '../platform/audit.js';
import { emit, verifyEventAuditAnchors } from '../platform/eventBus.js';
import { replayDeadLetter } from '../platform/outbox.js';
import { asUser, principalFor, tenantId, unscopedPrisma } from './helpers.js';

const CHAIR = 'chairman@kaizen.co.in';
const PROBE = 'kz.crm.anchorprobe.recorded';
let TENANT: string;

beforeAll(async () => {
  TENANT = await tenantId();
  await principalFor(CHAIR);
});

/** A dead letter for a fresh event, written the way the dispatcher leaves one behind. */
async function deadLetterFor(eventName: string) {
  const env = await asUser(CHAIR, () =>
    emit({ name: eventName, subject: { entityType: 'anchor_probe', entityId: randomUUID() } }),
  );
  const record = await unscopedPrisma.eventRecord.findFirstOrThrow({
    where: { tenantId: TENANT, eventId: env.eventId, eventName },
  });
  await unscopedPrisma.outboxEvent.updateMany({
    where: { tenantId: TENANT, eventRecordId: record.id },
    data: { state: 'dead', attempts: 8, lastError: 'boom' },
  });
  const letter = await unscopedPrisma.eventDeadLetter.create({
    data: {
      tenantId: TENANT,
      eventRecordId: record.id,
      eventName,
      subscriberKey: 'anchor.probe',
      attempts: 8,
      lastError: 'boom',
      payload: env as never,
    },
  });
  return { letter, record };
}

describe('a governed write pairs its audit row and its event', () => {
  it('replaying a dead letter writes an audit row and an event that name each other', async () => {
    const { letter } = await deadLetterFor(PROBE);
    await asUser(CHAIR, () => replayDeadLetter(letter.id));

    const audit = await unscopedPrisma.auditRecord.findFirstOrThrow({
      where: { tenantId: TENANT, subjectType: 'event_dead_letter', subjectId: letter.id, action: 'update' },
    });
    const fact = await unscopedPrisma.eventRecord.findFirstOrThrow({
      where: { tenantId: TENANT, eventName: EVENTS.OUTBOX_DEAD_LETTER_REPLAYED, subjectEntityId: letter.id },
    });

    // The event names its audit row. The audit row cannot name the event: it is written
    // first (rule 5), so the reverse direction is the lookup below, not a column.
    expect(fact.auditRecordId).toBe(audit.id);
    const eventsForAudit = await unscopedPrisma.eventRecord.findMany({
      where: { tenantId: TENANT, auditRecordId: audit.id },
    });
    expect(eventsForAudit.map((e) => e.id)).toEqual([fact.id]);

    // A paired write is not an orphan in either direction.
    const report = await verifyEventAuditAnchors(TENANT);
    expect(report.eventsWithoutAudit.map((e) => e.eventRecordId)).not.toContain(fact.id);
    expect(report.auditWithoutEvent.map((a) => a.auditRecordId)).not.toContain(audit.id);
  });
});

describe('the orphan verifier finds planted orphans', () => {
  it('reports an event anchored to no audit row, and one anchored to another subject', async () => {
    const missing = `missing-${randomUUID()}`;
    const envMissing = await asUser(CHAIR, () =>
      emit({
        name: PROBE,
        subject: { entityType: 'anchor_probe', entityId: randomUUID() },
        auditRecordId: missing,
      }),
    );

    // A real audit row, but for a different subject than the event below.
    const otherSubject = randomUUID();
    await asUser(CHAIR, () =>
      auditWrite({ action: 'create', subjectType: 'event_dead_letter', subjectId: otherSubject, after: { x: 1 } }),
    );
    const otherAudit = await unscopedPrisma.auditRecord.findFirstOrThrow({
      where: { tenantId: TENANT, subjectType: 'event_dead_letter', subjectId: otherSubject },
    });
    const envMismatch = await asUser(CHAIR, () =>
      emit({
        name: PROBE,
        subject: { entityType: 'anchor_probe', entityId: randomUUID() },
        auditRecordId: otherAudit.id,
      }),
    );

    const report = await verifyEventAuditAnchors(TENANT);
    const recordOf = (eventId: string) =>
      unscopedPrisma.eventRecord.findFirstOrThrow({ where: { tenantId: TENANT, eventId, eventName: PROBE } });
    const missingRecord = await recordOf(envMissing.eventId);
    const mismatchRecord = await recordOf(envMismatch.eventId);

    expect(report.eventsWithoutAudit).toContainEqual(
      expect.objectContaining({ eventRecordId: missingRecord.id, auditRecordId: missing, reason: 'missing_audit_row' }),
    );
    expect(report.eventsWithoutAudit).toContainEqual(
      expect.objectContaining({
        eventRecordId: mismatchRecord.id,
        auditRecordId: otherAudit.id,
        reason: 'subject_mismatch',
      }),
    );
  });

  it('reports a governed-write audit row that no event is anchored to', async () => {
    // An auditWrite with no transaction and no emit: the row commits alone, so no event can point at it.
    const orphanSubject = randomUUID();
    await asUser(CHAIR, () =>
      auditWrite({
        action: 'update',
        subjectType: 'event_dead_letter',
        subjectId: orphanSubject,
        before: { state: 'dead' },
        after: { state: 'replayed' },
      }),
    );
    const orphan = await unscopedPrisma.auditRecord.findFirstOrThrow({
      where: { tenantId: TENANT, subjectType: 'event_dead_letter', subjectId: orphanSubject },
    });

    const report = await verifyEventAuditAnchors(TENANT);
    expect(report.auditWithoutEvent).toContainEqual(
      expect.objectContaining({ auditRecordId: orphan.id, action: 'update', subjectId: orphanSubject }),
    );
  });
});
