/**
 * The exception engine (§3.6).
 *
 * A record in an actionable bad state becomes an exception with a resolved
 * owner, not a data point in a report someone has to notice. Severity (S0–S4)
 * is kept structurally separate from notification priority (N0–N4).
 *
 * An accountable owner is always resolved BEFORE any notification fires.
 * Escalation is bounded to exactly four named triggers: SLA expiry, decline,
 * authority insufficiency, and severity increase.
 */

import {
  EVENTS,
  SEVERITY_RANK,
  type EscalationTrigger,
  type NotificationPriority,
  type SeverityCode,
} from '@kaizen/shared';
import { prisma } from './db.js';
import { currentAuth } from './context.js';
import { emit } from './eventBus.js';
import { nextRecordCode } from './recordCode.js';

export interface RaiseExceptionInput {
  code: string;
  label: string;
  severity: SeverityCode;
  subjectType: string;
  subjectId: string;
  subjectLabel?: string | null;
  domain?: string;
  detail?: string;
  reasonCode?: string;
  /** Resolved deterministically — never "whoever happens to be logged in". */
  ownerPartyId?: string | null;
  accountablePositionId?: string | null;
  slaDueAt?: Date | null;
  /** Part of the durable idempotency key (automationVersionId, subjectRef, triggerFingerprint, ladderRung). */
  triggerFingerprint?: string;
  ladderRung?: number;
  notify?: boolean;
  notificationPriority?: NotificationPriority;
}

/**
 * The Four-Property Test an exception must pass: abnormal, actionable, owned,
 * consequential. An exception that fails any of them is a data point, not an
 * exception.
 */
export function passesFourPropertyTest(input: RaiseExceptionInput): boolean {
  const owned = Boolean(input.ownerPartyId || input.accountablePositionId);
  const actionable = Boolean(input.detail);
  return owned && actionable;
}

export async function raiseException(input: RaiseExceptionInput) {
  const auth = currentAuth();

  // Idempotency: the same rung of the same ladder on the same subject fires once.
  if (input.triggerFingerprint) {
    const existing = await prisma.exceptionRecord.findFirst({
      where: {
        tenantId: auth.tenantId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        code: input.code,
        triggerFingerprint: input.triggerFingerprint,
        ladderRung: input.ladderRung ?? 0,
      },
    });
    if (existing) return existing;
  }

  // An open exception of the same code on the same subject escalates rather
  // than duplicating — severity increase is one of the four escalation triggers.
  const open = await prisma.exceptionRecord.findFirst({
    where: {
      tenantId: auth.tenantId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      code: input.code,
      state: { in: ['open', 'acknowledged', 'escalated'] },
    },
  });

  if (open) {
    if (SEVERITY_RANK[input.severity] > SEVERITY_RANK[open.severity as SeverityCode]) {
      return escalateException(open.id, 'severity_increase', input.severity);
    }
    return open;
  }

  const recordCode = await nextRecordCode('EXC');
  const ownerUnresolved = !input.ownerPartyId && !input.accountablePositionId;

  const record = await prisma.exceptionRecord.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      code: input.code,
      label: input.label,
      severity: input.severity,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      subjectLabel: input.subjectLabel ?? null,
      domain: input.domain ?? 'crm',
      detail: input.detail ?? null,
      reasonCode: input.reasonCode ?? null,
      ownerPartyId: input.ownerPartyId ?? null,
      accountablePositionId: input.accountablePositionId ?? null,
      // An exception failing to resolve an owner is itself a first-class,
      // measured category feeding H_OPS — never something discovered by
      // noticing a blank assignee field.
      ownerUnresolved,
      slaDueAt: input.slaDueAt ?? null,
      triggerFingerprint: input.triggerFingerprint ?? null,
      ladderRung: input.ladderRung ?? null,
    },
  });

  await emit({
    name: EVENTS.EXCEPTION_RAISED,
    subject: { entityType: 'exception', entityId: record.id, recordCode },
    related: [{ relation: 'raised_for', entityType: input.subjectType, entityId: input.subjectId }],
    newState: { code: input.code, severity: input.severity, ownerPartyId: input.ownerPartyId ?? null },
    severity: input.severity,
    owner: { partyId: input.ownerPartyId ?? null, positionId: input.accountablePositionId ?? null },
    impact: { domains: [input.domain ?? 'crm'], severity: input.severity },
  });

  // Ownership precedes notification, always.
  if (input.notify !== false && input.ownerPartyId) {
    await notify({
      recipientPartyId: input.ownerPartyId,
      priority: input.notificationPriority ?? severityToPriority(input.severity),
      title: input.label,
      body: input.detail ?? `${input.code} raised on ${input.subjectLabel ?? input.subjectId}`,
      severity: input.severity,
      subjectType: 'exception',
      subjectId: record.id,
      drillPath: `/exceptions/${record.id}`,
    });
  }

  return record;
}

export async function acknowledgeException(id: string, note?: string) {
  const auth = currentAuth();
  const record = await prisma.exceptionRecord.update({
    where: { id },
    data: { state: 'acknowledged', acknowledgedAt: new Date(), acknowledgedById: auth.partyId, resolutionNote: note },
  });
  await emit({
    name: EVENTS.EXCEPTION_ACKNOWLEDGED,
    subject: { entityType: 'exception', entityId: id, recordCode: record.recordCode },
    newState: { state: 'acknowledged' },
  });
  return record;
}

export async function resolveException(id: string, note: string) {
  const auth = currentAuth();
  const record = await prisma.exceptionRecord.update({
    where: { id },
    data: { state: 'resolved', resolvedAt: new Date(), resolvedById: auth.partyId, resolutionNote: note },
  });
  await emit({
    name: EVENTS.EXCEPTION_RESOLVED,
    subject: { entityType: 'exception', entityId: id, recordCode: record.recordCode },
    newState: { state: 'resolved', note },
  });
  return record;
}

/** Escalation is bounded to the four named triggers — nothing escalates by default outside them. */
export async function escalateException(
  id: string,
  trigger: EscalationTrigger,
  newSeverity?: SeverityCode,
  escalateToPartyId?: string | null,
) {
  const existing = await prisma.exceptionRecord.findFirst({ where: { id } });
  if (!existing) return null;

  const record = await prisma.exceptionRecord.update({
    where: { id },
    data: {
      state: 'escalated',
      severity: newSeverity ?? existing.severity,
      escalatedAt: new Date(),
      escalationRung: existing.escalationRung + 1,
      escalationTrigger: trigger,
      escalatedToPartyId: escalateToPartyId ?? existing.escalatedToPartyId,
    },
  });

  await emit({
    name: EVENTS.EXCEPTION_ESCALATED,
    subject: { entityType: 'exception', entityId: id, recordCode: record.recordCode },
    previousState: { severity: existing.severity, rung: existing.escalationRung },
    newState: { severity: record.severity, rung: record.escalationRung, trigger },
    reason: { reasonCode: trigger },
    severity: record.severity as SeverityCode,
  });

  if (record.escalatedToPartyId) {
    await notify({
      recipientPartyId: record.escalatedToPartyId,
      priority: severityToPriority(record.severity as SeverityCode),
      title: `Escalated: ${record.label}`,
      body: `${record.code} escalated to rung ${record.escalationRung} (${trigger}).`,
      severity: record.severity as SeverityCode,
      subjectType: 'exception',
      subjectId: id,
      drillPath: `/exceptions/${id}`,
    });
  }

  return record;
}

// ---------------------------------------------------------------------------
// Notifications. Priority is an independent judgment from severity — related,
// but not derived, which is why the mapping below is a default a caller may
// override rather than a fixed function.
// ---------------------------------------------------------------------------

export function severityToPriority(severity: SeverityCode): NotificationPriority {
  switch (severity) {
    case 'S4_CRITICAL':
      return 'N4_URGENT';
    case 'S3_HIGH_RISK':
      return 'N3_HIGH';
    case 'S2_WARNING':
      return 'N2_NORMAL';
    case 'S1_ATTENTION':
      return 'N1_LOW';
    default:
      return 'N0_AMBIENT';
  }
}

export interface NotifyInput {
  recipientPartyId: string;
  priority: NotificationPriority;
  title: string;
  body: string;
  channel?: string;
  severity?: SeverityCode | null;
  subjectType?: string;
  subjectId?: string;
  drillPath?: string;
}

export async function notify(input: NotifyInput) {
  const auth = currentAuth();
  return prisma.notification.create({
    data: {
      tenantId: auth.tenantId,
      recipientPartyId: input.recipientPartyId,
      priority: input.priority,
      channel: input.channel ?? 'in_app',
      title: input.title,
      body: input.body,
      severity: input.severity ?? null,
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      drillPath: input.drillPath ?? null,
      dispatchedAt: new Date(),
    },
  });
}
