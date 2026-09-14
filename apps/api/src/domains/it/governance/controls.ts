/**
 * Technology — the control library (docs/plan/cio.md, workstream F).
 *
 * A control's `lastTestedAt`/`lastResult` are a projection of the latest
 * `ItControlTest` row, never edited independently of it (Principle 5) — the
 * only way they change is through `recordTest`.
 */

import { EVENTS, IT_DOMAIN } from '@kaizen/shared';
import { prisma } from '../../../platform/db.js';
import { currentAuth } from '../../../platform/context.js';
import { emit } from '../../../platform/eventBus.js';
import { nextRecordCode } from '../../../platform/recordCode.js';
import { ApiError } from '../../../platform/errors.js';
import { assertCan } from '../../../platform/permissions.js';
import { auditWrite, registerGovernedEntities } from '../../../platform/audit.js';

registerGovernedEntities('it_governance', ['it_control', 'it_control_test']);

const RESOURCE = 'it_controls';
const RESULTS = ['pass', 'fail', 'partial'];

export interface CreateControlInput {
  code: string;
  title: string;
  frameworkRefs: Array<{ framework: string; ref: string }>;
  ownerPartyId: string;
  frequencyDays: number;
}

export async function createControl(input: CreateControlInput) {
  await assertCan({ resource: RESOURCE, verb: 'create' });
  const auth = currentAuth();

  const code = input.code?.trim();
  const title = input.title?.trim();
  if (!code) throw ApiError.badRequest('A control needs a code.');
  if (!title) throw ApiError.badRequest('A control needs a title.');
  if (!input.ownerPartyId) throw ApiError.badRequest('A control needs an owner.');
  if (!input.frequencyDays || input.frequencyDays < 1) throw ApiError.badRequest('A control needs a positive test frequency in days.');

  const existing = await prisma.itControl.findFirst({ where: { tenantId: auth.tenantId, code } });
  if (existing) throw ApiError.conflict(`'${code}' already names a control (${existing.recordCode}).`);

  const recordCode = await nextRecordCode('CTL');
  const control = await prisma.itControl.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      code,
      title,
      frameworkRefs: input.frameworkRefs ?? [],
      ownerPartyId: input.ownerPartyId,
      frequencyDays: input.frequencyDays,
      status: 'active',
    },
  });

  await auditWrite({ action: 'create', subjectType: 'it_control', subjectId: control.id, after: { recordCode, code, title } });
  return control;
}

export interface UpdateControlInput {
  title?: string;
  frameworkRefs?: Array<{ framework: string; ref: string }>;
  ownerPartyId?: string;
  frequencyDays?: number;
  status?: string;
}

export async function updateControl(id: string, patch: UpdateControlInput) {
  const auth = currentAuth();
  const control = await prisma.itControl.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!control) throw ApiError.notFound('Control');
  await assertCan({ resource: RESOURCE, verb: 'edit', record: { ownerPartyId: control.ownerPartyId } });

  if (patch.status && !['active', 'retired'].includes(patch.status)) {
    throw ApiError.badRequest("Control status must be 'active' or 'retired'.");
  }

  const updated = await prisma.itControl.update({
    where: { id },
    data: {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.frameworkRefs !== undefined ? { frameworkRefs: patch.frameworkRefs } : {}),
      ...(patch.ownerPartyId !== undefined ? { ownerPartyId: patch.ownerPartyId } : {}),
      ...(patch.frequencyDays !== undefined ? { frequencyDays: patch.frequencyDays } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    },
  });
  await auditWrite({ action: 'update', subjectType: 'it_control', subjectId: id, before: control, after: updated });
  return updated;
}

export interface ControlFilter {
  status?: string;
  framework?: string;
}

export async function listControls(filter: ControlFilter = {}) {
  await assertCan({ resource: RESOURCE, verb: 'view' });
  const auth = currentAuth();
  const rows = await prisma.itControl.findMany({
    where: { tenantId: auth.tenantId, ...(filter.status ? { status: filter.status } : {}) },
    orderBy: { code: 'asc' },
  });
  if (!filter.framework) return rows;
  return rows.filter((r) => (r.frameworkRefs as Array<{ framework: string }>).some((f) => f.framework === filter.framework));
}

export async function controlDetail(id: string) {
  const auth = currentAuth();
  const control = await prisma.itControl.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!control) throw ApiError.notFound('Control');
  await assertCan({ resource: RESOURCE, verb: 'view' });
  const tests = await prisma.itControlTest.findMany({ where: { tenantId: auth.tenantId, controlId: id }, orderBy: { testedAt: 'desc' } });
  return { ...control, tests };
}

export interface RecordTestInput {
  result: string;
  notes?: string | null;
  evidenceDocumentId?: string | null;
}

export async function recordTest(id: string, input: RecordTestInput) {
  const auth = currentAuth();
  const control = await prisma.itControl.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!control) throw ApiError.notFound('Control');
  await assertCan({ resource: RESOURCE, verb: 'edit', record: { ownerPartyId: control.ownerPartyId } });

  if (!RESULTS.includes(input.result)) throw ApiError.badRequest(`Result must be one of: ${RESULTS.join(', ')}.`);

  const now = new Date();
  const test = await prisma.itControlTest.create({
    data: {
      tenantId: auth.tenantId,
      controlId: id,
      testedAt: now,
      result: input.result,
      testerPartyId: auth.partyId ?? 'system',
      notes: input.notes ?? null,
      evidenceDocumentId: input.evidenceDocumentId ?? null,
    },
  });

  const updated = await prisma.itControl.update({
    where: { id },
    data: { lastTestedAt: now, lastResult: input.result, testOverdueNotifiedAt: null },
  });

  await auditWrite({ action: 'create', subjectType: 'it_control_test', subjectId: test.id, after: { controlId: id, result: input.result } });
  await emit({
    name: EVENTS.IT_CONTROL_TESTED,
    subject: { entityType: 'it_control', entityId: id, recordCode: control.recordCode },
    newState: { lastResult: input.result, lastTestedAt: now },
    owner: { partyId: control.ownerPartyId },
    impact: { domains: [IT_DOMAIN] },
  });

  return { ...updated, tests: [test] };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export async function controlsSummary() {
  await assertCan({ resource: RESOURCE, verb: 'view' });
  const auth = currentAuth();
  const total = await prisma.itControl.count({ where: { tenantId: auth.tenantId } });
  if (total === 0) {
    return { notYetMeasured: true, active: 0, testedInPeriod: 0, failing: 0, overdue: 0 };
  }

  const rows = await prisma.itControl.findMany({ where: { tenantId: auth.tenantId, status: 'active' } });
  const now = new Date();
  const periodStart = new Date(now.getTime() - 90 * 86_400_000);

  let testedInPeriod = 0;
  let failing = 0;
  let overdue = 0;
  for (const r of rows) {
    if (r.lastTestedAt && r.lastTestedAt >= periodStart) testedInPeriod += 1;
    if (r.lastResult === 'fail') failing += 1;
    const nextDue = r.lastTestedAt ? new Date(r.lastTestedAt.getTime() + r.frequencyDays * 86_400_000) : null;
    if (!nextDue || nextDue < now) overdue += 1;
  }

  return { notYetMeasured: false, active: rows.length, testedInPeriod, failing, overdue };
}
