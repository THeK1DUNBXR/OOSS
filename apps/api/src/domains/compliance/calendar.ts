/**
 * Compliance calendar and register (docs/plan/compliance.md, workstream A).
 *
 * The spine every other compliance workstream's deadlines sit on. A
 * `ComplianceObligationType` is the standing rule — GSTR-3B is due on the
 * 20th of next month, PF ECR on the 15th; a `ComplianceObligation` is one
 * period's instance of it, materialised ahead of time by
 * `generateObligations` so a deadline is a row waiting to be filed, never a
 * date somebody has to remember.
 *
 * An obligation's owner is never a role comparison in this file's logic — it
 * is resolved by looking up the active `Affiliation` whose `roleSlug` matches
 * the type's `ownerRoleSlug`, exactly the data-driven shape
 * `platform/permissions.ts` uses for a scope resolver. An obligation nobody
 * currently holds that role for is not silently skipped: it raises
 * `CMP_CAL_UNOWNED` against `H_OPS`, the same "unowned exception" category
 * the health score already tracks.
 */

import { EVENTS, nextDueDates, type ComplianceDueRule, type ComplianceRecurrence } from '@kaizen/shared';
import { prisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { emit } from '../../platform/eventBus.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan } from '../../platform/permissions.js';
import { auditWrite, registerGovernedEntities } from '../../platform/audit.js';
import { raiseException } from '../../platform/exceptions.js';

registerGovernedEntities('cmp_cal', ['compliance_obligation', 'compliance_obligation_type']);

const DEFAULT_HORIZON_MONTHS = 3;

/** Resolves an obligation's owner: the partyId of an active affiliation
 * carrying the type's `ownerRoleSlug`. Data, never a role-slug branch. */
export async function resolveOwnerPartyId(ownerRoleSlug: string): Promise<string | null> {
  const auth = currentAuth();
  const affiliation = await prisma.affiliation.findFirst({
    where: { tenantId: auth.tenantId, roleSlug: ownerRoleSlug, status: 'active' },
    orderBy: [{ primaryFlag: 'desc' }, { createdAt: 'asc' }],
  });
  return affiliation?.partyId ?? null;
}

/**
 * Raises `CMP_CAL_UNOWNED` when no active affiliation answers to the type's
 * owner role. This is what CMP-CAL-003 asks for: an unowned obligation is a
 * routing defect visible in `H_OPS`, never a row that quietly has nobody
 * behind it.
 */
async function flagUnowned(obligation: { id: string; recordCode: string | null }, type: { code: string; label: string; domain: string; ownerRoleSlug: string }) {
  await raiseException({
    code: 'CMP_CAL_UNOWNED',
    label: `No ${type.ownerRoleSlug} to own ${type.label}`,
    severity: 'S2_WARNING',
    subjectType: 'compliance_obligation',
    subjectId: obligation.id,
    subjectLabel: obligation.recordCode ?? type.code,
    domain: type.domain,
    detail: `${type.label} needs an active affiliation carrying the '${type.ownerRoleSlug}' role, and none exists. Assign the role, or this obligation has nobody accountable for filing it.`,
    // Deliberately no ownerPartyId/accountablePositionId: an unresolved owner
    // is the fact being reported, not something to paper over with a
    // fallback assignee. `raiseException` records `ownerUnresolved: true`.
    triggerFingerprint: 'compliance_obligation_unowned',
  });
}

// ---------------------------------------------------------------------------
// Materialisation
// ---------------------------------------------------------------------------

export interface GenerateResult {
  created: number;
  skipped: number;
  unowned: number;
}

/**
 * Materialises every active type's obligations for the next `horizonMonths`.
 * Idempotent: a period already materialised for a type (the
 * `(tenantId, typeId, period)` unique constraint) is left exactly as it
 * stands — a row already filed or waived is never reset back to `upcoming`
 * by a re-run.
 */
export async function generateObligations(horizonMonths: number = DEFAULT_HORIZON_MONTHS): Promise<GenerateResult> {
  const auth = currentAuth();
  if (auth.principalType !== 'system') {
    await assertCan({ resource: 'compliance_obligations', verb: 'create' });
  }

  const types = await prisma.complianceObligationType.findMany({ where: { tenantId: auth.tenantId, active: true } });
  const now = new Date();

  let created = 0;
  let skipped = 0;
  let unowned = 0;

  for (const type of types) {
    const occurrences = nextDueDates(type.dueRule as ComplianceDueRule, type.recurrence as ComplianceRecurrence, now, horizonMonths);
    for (const occ of occurrences) {
      const existing = await prisma.complianceObligation.findFirst({
        where: { tenantId: auth.tenantId, typeId: type.id, period: occ.period },
      });
      if (existing) {
        skipped += 1;
        continue;
      }

      const recordCode = await nextRecordCode('CMP');
      const obligation = await prisma.complianceObligation.create({
        data: {
          tenantId: auth.tenantId,
          typeId: type.id,
          period: occ.period,
          dueAt: occ.dueAt,
          status: 'upcoming',
          recordCode,
        },
      });
      created += 1;

      await auditWrite({
        action: 'create',
        subjectType: 'compliance_obligation',
        subjectId: obligation.id,
        after: { recordCode, typeCode: type.code, period: occ.period, dueAt: occ.dueAt },
      });

      const ownerPartyId = await resolveOwnerPartyId(type.ownerRoleSlug);
      if (!ownerPartyId) {
        unowned += 1;
        await flagUnowned(obligation, type);
      }
    }
  }

  if (created) {
    await emit({
      name: EVENTS.COMPLIANCE_OBLIGATIONS_GENERATED,
      subject: { entityType: 'compliance_obligation', entityId: 'bulk', recordCode: null },
      newState: { created, skipped, unowned, horizonMonths },
      impact: { domains: ['gov'] },
    });
  }

  return { created, skipped, unowned };
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export interface ObligationFilter {
  status?: string;
  domain?: string;
  period?: string;
  typeId?: string;
}

export async function listTypes() {
  const auth = currentAuth();
  await assertCan({ resource: 'compliance_obligations', verb: 'view' });
  return prisma.complianceObligationType.findMany({ where: { tenantId: auth.tenantId }, orderBy: { code: 'asc' } });
}

export async function listObligations(filter: ObligationFilter = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'compliance_obligations', verb: 'view' });
  return prisma.complianceObligation.findMany({
    where: {
      tenantId: auth.tenantId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.period ? { period: filter.period } : {}),
      ...(filter.typeId ? { typeId: filter.typeId } : {}),
      ...(filter.domain ? { type: { domain: filter.domain } } : {}),
    },
    include: { type: true },
    orderBy: { dueAt: 'asc' },
  });
}

export async function obligationDetail(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'compliance_obligations', verb: 'view' });
  const obligation = await prisma.complianceObligation.findFirst({
    where: { id, tenantId: auth.tenantId },
    include: { type: true },
  });
  if (!obligation) throw ApiError.notFound('Compliance obligation');
  return obligation;
}

// ---------------------------------------------------------------------------
// Filing and waiver
// ---------------------------------------------------------------------------

export interface MarkFiledInput {
  reference: string;
  evidenceDocumentId?: string | null;
  note?: string | null;
}

/**
 * Records that an obligation was filed on the portal.
 *
 * `approve` rather than `edit`: filing is the irreversible half, the way
 * `markReturnFiled` treats a GST filing. A reference — ARN, challan number,
 * acknowledgement number — is always required; when the type says evidence
 * is required, a linked document is too. Neither is optional and there is no
 * way to flip the status without them (CMP-CAL-002).
 */
export async function markFiled(id: string, input: MarkFiledInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'compliance_obligations', verb: 'approve' });

  const obligation = await prisma.complianceObligation.findFirst({
    where: { id, tenantId: auth.tenantId },
    include: { type: true },
  });
  if (!obligation) throw ApiError.notFound('Compliance obligation');
  if (obligation.status === 'filed') {
    throw ApiError.conflict(`${obligation.recordCode ?? obligation.id} is already filed.`);
  }
  if (obligation.status === 'waived') {
    throw ApiError.conflict(`${obligation.recordCode ?? obligation.id} was waived, not filed. Waiving is a deliberate decision not to file — it is not corrected by filing over it.`);
  }

  const reference = input.reference?.trim();
  if (!reference) {
    throw ApiError.badRequest(
      `CMP-CAL-002: ${obligation.type.label} needs a reference — the ARN, challan or acknowledgement number the portal gave back. Filing happens on the portal; this only records what came back from it.`,
    );
  }
  if (obligation.type.evidenceRequired && !input.evidenceDocumentId) {
    throw ApiError.badRequest(
      `CMP-CAL-002: ${obligation.type.label} requires evidence on file before it can be marked filed. Attach the filed document first.`,
    );
  }

  const filed = await prisma.complianceObligation.update({
    where: { id },
    data: {
      status: 'filed',
      filedAt: new Date(),
      filedById: auth.partyId,
      reference,
      evidenceDocumentId: input.evidenceDocumentId ?? null,
      ...(input.note ? { note: input.note } : {}),
    },
  });

  await auditWrite({
    action: 'update',
    subjectType: 'compliance_obligation',
    subjectId: id,
    before: { status: obligation.status },
    after: { status: 'filed', reference, filedById: auth.partyId },
  });
  await emit({
    name: EVENTS.COMPLIANCE_OBLIGATION_FILED,
    subject: { entityType: 'compliance_obligation', entityId: id, recordCode: filed.recordCode },
    newState: { status: 'filed', reference },
    impact: { domains: [obligation.type.domain] },
  });

  return filed;
}

/** A deliberate decision not to file — distinct from filing, and distinct
 * from letting a deadline drift unattended. */
export async function waive(id: string, reason: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'compliance_obligations', verb: 'approve' });

  const trimmed = reason?.trim();
  if (!trimmed) throw ApiError.badRequest('A waiver needs a reason — it is a decision, not a shrug.');

  const obligation = await prisma.complianceObligation.findFirst({ where: { id, tenantId: auth.tenantId }, include: { type: true } });
  if (!obligation) throw ApiError.notFound('Compliance obligation');
  if (obligation.status === 'filed') {
    throw ApiError.conflict(`${obligation.recordCode ?? obligation.id} is already filed and cannot be waived.`);
  }

  const waived = await prisma.complianceObligation.update({
    where: { id },
    data: { status: 'waived', note: trimmed },
  });

  await auditWrite({
    action: 'update',
    subjectType: 'compliance_obligation',
    subjectId: id,
    before: { status: obligation.status },
    after: { status: 'waived', note: trimmed },
  });
  await emit({
    name: EVENTS.COMPLIANCE_OBLIGATION_WAIVED,
    subject: { entityType: 'compliance_obligation', entityId: id, recordCode: waived.recordCode },
    newState: { status: 'waived', reason: trimmed },
    impact: { domains: [obligation.type.domain] },
  });

  return waived;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export async function summary() {
  const auth = currentAuth();
  await assertCan({ resource: 'compliance_obligations', verb: 'view' });

  const total = await prisma.complianceObligationType.count({ where: { tenantId: auth.tenantId } });
  if (total === 0) {
    return {
      notYetMeasured: true,
      byStatus: { upcoming: 0, due: 0, filed: 0, overdue: 0, waived: 0 },
      byDomain: { fin: 0, hr: 0, gov: 0, edu: 0 },
      filedThisFy: 0,
    };
  }

  const rows = await prisma.complianceObligation.findMany({
    where: { tenantId: auth.tenantId },
    include: { type: true },
  });

  const byStatus = { upcoming: 0, due: 0, filed: 0, overdue: 0, waived: 0 };
  const byDomain = { fin: 0, hr: 0, gov: 0, edu: 0 };
  for (const row of rows) {
    byStatus[row.status as keyof typeof byStatus] = (byStatus[row.status as keyof typeof byStatus] ?? 0) + 1;
    const domain = row.type.domain as keyof typeof byDomain;
    byDomain[domain] = (byDomain[domain] ?? 0) + 1;
  }

  const now = new Date();
  const fyStartYear = now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const fyStart = new Date(Date.UTC(fyStartYear, 3, 1));
  const fyEnd = new Date(Date.UTC(fyStartYear + 1, 3, 1));
  const filedThisFy = rows.filter((r) => r.status === 'filed' && r.filedAt && r.filedAt >= fyStart && r.filedAt < fyEnd).length;

  return { notYetMeasured: false, byStatus, byDomain, filedThisFy };
}
