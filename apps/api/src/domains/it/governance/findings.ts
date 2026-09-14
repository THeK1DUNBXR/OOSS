/**
 * Technology — security findings (docs/plan/cio.md, workstream F).
 *
 * `dueAt` is computed once at creation from the `ItRemediationRule` in force
 * that day (`remediationDueAt`, packages/shared/src/it/governance.ts) and
 * never recomputed by a later change to the table (IT-FND-001).
 */

import {
  EVENTS,
  IT_DOMAIN,
  remediationDueAt,
  findingMachine,
  FINDING_LADDER_RUNGS,
  type FindingState,
  type FindingEvent,
  type FindingSeverity,
  type RemediationRuleRow,
} from '@kaizen/shared';
import { prisma } from '../../../platform/db.js';
import { currentAuth } from '../../../platform/context.js';
import { emit } from '../../../platform/eventBus.js';
import { availableTransitions } from '../../../platform/lifecycle.js';
import { nextRecordCode } from '../../../platform/recordCode.js';
import { ApiError } from '../../../platform/errors.js';
import { assertCan } from '../../../platform/permissions.js';
import { auditWrite, registerGovernedEntities } from '../../../platform/audit.js';
import { raiseException } from '../../../platform/exceptions.js';
import { resolveOpsHeadPartyId } from './risks.js';

registerGovernedEntities('it_governance', ['it_security_finding', 'it_remediation_rule']);

const RESOURCE = 'it_findings';
const SOURCES = ['pentest', 'scan', 'audit', 'internal'];
const SEVERITIES: FindingSeverity[] = ['critical', 'high', 'medium', 'low'];

async function remediationRules(): Promise<RemediationRuleRow[]> {
  const auth = currentAuth();
  const rows = await prisma.itRemediationRule.findMany({ where: { tenantId: auth.tenantId } });
  return rows.map((r) => ({ severity: r.severity as FindingSeverity, days: r.days, effectiveFrom: r.effectiveFrom }));
}

// ---------------------------------------------------------------------------
// Create / read
// ---------------------------------------------------------------------------

export interface CreateFindingInput {
  title: string;
  source: string;
  severity: string;
  cvss?: number | null;
  description?: string | null;
  applicationId?: string | null;
  assetId?: string | null;
}

export async function createFinding(input: CreateFindingInput) {
  await assertCan({ resource: RESOURCE, verb: 'create' });
  const auth = currentAuth();

  const title = input.title?.trim();
  if (!title) throw ApiError.badRequest('A finding needs a title.');
  if (!SOURCES.includes(input.source)) throw ApiError.badRequest(`Source must be one of: ${SOURCES.join(', ')}.`);
  if (!SEVERITIES.includes(input.severity as FindingSeverity)) throw ApiError.badRequest(`Severity must be one of: ${SEVERITIES.join(', ')}.`);

  const now = new Date();
  const rules = await remediationRules();
  let dueAt: Date;
  try {
    dueAt = remediationDueAt(now, input.severity as FindingSeverity, rules);
  } catch {
    throw ApiError.unprocessable(`No remediation rule for severity '${input.severity}' is in force yet. Run the seed before raising a finding.`);
  }

  const recordCode = await nextRecordCode('FND');
  const finding = await prisma.itSecurityFinding.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      title,
      source: input.source,
      severity: input.severity,
      cvss: input.cvss ?? null,
      description: input.description ?? null,
      applicationId: input.applicationId ?? null,
      assetId: input.assetId ?? null,
      dueAt,
      status: 'open',
    },
  });

  await auditWrite({ action: 'create', subjectType: 'it_security_finding', subjectId: finding.id, after: { recordCode, severity: input.severity, dueAt } });
  await emit({
    name: EVENTS.IT_FINDING_RAISED,
    subject: { entityType: 'it_security_finding', entityId: finding.id, recordCode },
    newState: { status: finding.status, severity: input.severity, dueAt },
    impact: { domains: [IT_DOMAIN] },
  });

  return withTransitions(finding);
}

export interface UpdateFindingInput {
  description?: string | null;
  changeId?: string | null;
  cvss?: number | null;
}

export async function updateFinding(id: string, patch: UpdateFindingInput) {
  const auth = currentAuth();
  const finding = await prisma.itSecurityFinding.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!finding) throw ApiError.notFound('Finding');
  await assertCan({ resource: RESOURCE, verb: 'edit' });

  const updated = await prisma.itSecurityFinding.update({
    where: { id },
    data: {
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.changeId !== undefined ? { changeId: patch.changeId } : {}),
      ...(patch.cvss !== undefined ? { cvss: patch.cvss } : {}),
    },
  });
  await auditWrite({ action: 'update', subjectType: 'it_security_finding', subjectId: id, before: finding, after: updated });
  return withTransitions(updated);
}

export interface FindingFilter {
  status?: string;
  severity?: string;
}

export async function listFindings(filter: FindingFilter = {}) {
  await assertCan({ resource: RESOURCE, verb: 'view' });
  const auth = currentAuth();
  const rows = await prisma.itSecurityFinding.findMany({
    where: {
      tenantId: auth.tenantId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.severity ? { severity: filter.severity } : {}),
    },
    orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }],
  });
  return rows.map(withTransitions);
}

export async function findingDetail(id: string) {
  const auth = currentAuth();
  const finding = await prisma.itSecurityFinding.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!finding) throw ApiError.notFound('Finding');
  await assertCan({ resource: RESOURCE, verb: 'view' });
  return withTransitions(finding);
}

function withTransitions<T extends { status: string }>(row: T): T & { availableTransitions: FindingEvent[] } {
  return { ...row, availableTransitions: availableTransitions(findingMachine, row.status as FindingState) };
}

// ---------------------------------------------------------------------------
// Transition
// ---------------------------------------------------------------------------

export async function transitionFinding(id: string, event: FindingEvent, note?: string | null) {
  const auth = currentAuth();
  const finding = await prisma.itSecurityFinding.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!finding) throw ApiError.notFound('Finding');
  await assertCan({ resource: RESOURCE, verb: 'edit' });

  const from = finding.status as FindingState;
  if (!findingMachine.can(from, event)) {
    throw ApiError.unprocessable(
      `ItSecurityFinding is ${from}; ${event} is not one of its transitions. From here it accepts: ${findingMachine.allowedEvents(from).join(', ') || 'nothing — this is a terminal state'}.`,
    );
  }
  const to = findingMachine.apply(from, event);

  const updated = await prisma.itSecurityFinding.update({ where: { id }, data: { status: to } });

  await auditWrite({ action: 'update', subjectType: 'it_security_finding', subjectId: id, before: { status: from }, after: { status: to }, meta: { transition: event } });
  await emit({
    name: EVENTS.IT_FINDING_TRANSITIONED,
    subject: { entityType: 'it_security_finding', entityId: id, recordCode: finding.recordCode },
    previousState: { status: from },
    newState: { status: to },
    reason: note ? { reasonCode: event, note } : null,
    impact: { domains: [IT_DOMAIN] },
  });

  return withTransitions(updated);
}

// ---------------------------------------------------------------------------
// Overdue ladder (jobs/it/governance.ts calls this)
// ---------------------------------------------------------------------------

export interface FindingLadderResult {
  checked: number;
  notified: number;
  skippedIdempotent: number;
}

export async function runFindingOverdueLadder(now: Date = new Date()): Promise<FindingLadderResult> {
  const auth = currentAuth();
  const rows = await prisma.itSecurityFinding.findMany({
    where: { tenantId: auth.tenantId, status: { in: ['open', 'in_progress'] } },
  });

  let notified = 0;
  let skippedIdempotent = 0;

  for (const row of rows) {
    const rungs = FINDING_LADDER_RUNGS[row.severity as FindingSeverity] ?? FINDING_LADDER_RUNGS.low;
    const daysToDue = Math.ceil((row.dueAt.getTime() - now.getTime()) / 86_400_000);
    const crossed = rungs.filter((r) => daysToDue <= r);
    const rung = crossed.length ? crossed[crossed.length - 1] : undefined;
    if (rung === undefined) continue;

    const already = row.overdueNotifiedRungs ?? [];
    if (already.includes(rung)) {
      skippedIdempotent += 1;
      continue;
    }

    const overdue = rung < 0;
    const opsHead = await resolveOpsHeadPartyId();
    await raiseException({
      code: overdue ? 'IT_FND_OVERDUE' : 'IT_FND_DUE',
      label: overdue ? `${row.title} remediation overdue` : `${row.title} remediation due in ${rung} day${rung === 1 ? '' : 's'}`,
      severity: overdue ? (row.severity === 'critical' ? 'S4_CRITICAL' : 'S3_HIGH_RISK') : 'S2_WARNING',
      subjectType: 'it_security_finding',
      subjectId: row.id,
      subjectLabel: row.recordCode,
      domain: IT_DOMAIN,
      detail: overdue
        ? `${row.title} (${row.recordCode}, ${row.severity}) was due ${row.dueAt.toISOString().slice(0, 10)} and remains ${row.status}.`
        : `${row.title} (${row.recordCode}, ${row.severity}) is due ${row.dueAt.toISOString().slice(0, 10)}.`,
      ownerPartyId: opsHead,
      slaDueAt: row.dueAt,
      triggerFingerprint: 'it_finding_overdue_ladder',
      ladderRung: rung,
    });
    notified += 1;
    await prisma.itSecurityFinding.update({ where: { id: row.id }, data: { overdueNotifiedRungs: [...new Set([...already, ...crossed])] } });
  }

  return { checked: rows.length, notified, skippedIdempotent };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export async function findingsSummary() {
  await assertCan({ resource: RESOURCE, verb: 'view' });
  const auth = currentAuth();
  const total = await prisma.itSecurityFinding.count({ where: { tenantId: auth.tenantId } });
  if (total === 0) {
    return { notYetMeasured: true, openBySeverity: { critical: 0, high: 0, medium: 0, low: 0 }, overdue: 0 };
  }

  const rows = await prisma.itSecurityFinding.findMany({ where: { tenantId: auth.tenantId, status: { in: ['open', 'in_progress'] } } });
  const now = new Date();
  const openBySeverity: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  let overdue = 0;
  for (const r of rows) {
    openBySeverity[r.severity] = (openBySeverity[r.severity] ?? 0) + 1;
    if (r.dueAt < now) overdue += 1;
  }
  return { notYetMeasured: false, openBySeverity, overdue };
}
