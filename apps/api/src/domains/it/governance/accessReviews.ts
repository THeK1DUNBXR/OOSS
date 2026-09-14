/**
 * Technology — access-review campaigns (docs/plan/cio.md, workstream F).
 *
 * Opening a campaign materialises one `ItAccessReviewItem` per active
 * `Affiliation` in scope — the same data `main.prisma` already carries for
 * who holds what role, never a role-slug branch. A reviewer may never decide
 * their own row (IT-ACR-001): the check compares `auth.partyId` against the
 * item's `partyId`, not against a role. A `revoke` decision raises an
 * exception for the Operations Head to act on rather than editing the
 * `Affiliation` itself — that model belongs to `main.prisma`, outside this
 * workstream's files.
 */

import {
  EVENTS,
  IT_DOMAIN,
  accessReviewMachine,
  GOVERNANCE_LADDER_RUNGS,
  type AccessReviewState,
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

registerGovernedEntities('it_governance', ['it_access_review', 'it_access_review_item']);

const RESOURCE = 'it_access_reviews';
const SCOPES = ['all', 'role', 'application'];
const DECISIONS = ['keep', 'revoke', 'modify'];

// ---------------------------------------------------------------------------
// Open / read
// ---------------------------------------------------------------------------

export interface OpenCampaignInput {
  name: string;
  scope: string;
  scopeRef?: string | null;
  dueAt: Date;
}

export async function openCampaign(input: OpenCampaignInput) {
  const auth = currentAuth();
  await assertCan({ resource: RESOURCE, verb: 'create' });

  const name = input.name?.trim();
  if (!name) throw ApiError.badRequest('A campaign needs a name.');
  if (!SCOPES.includes(input.scope)) throw ApiError.badRequest(`Scope must be one of: ${SCOPES.join(', ')}.`);
  if (input.scope !== 'all' && !input.scopeRef?.trim()) {
    throw ApiError.badRequest(`A '${input.scope}' campaign needs a scopeRef naming the role or application.`);
  }
  if (!input.dueAt) throw ApiError.badRequest('A campaign needs a due date.');

  const recordCode = await nextRecordCode('ACR');
  const campaign = await prisma.itAccessReview.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      name,
      scope: input.scope,
      scopeRef: input.scopeRef ?? null,
      dueAt: input.dueAt,
      status: 'open',
      openedById: auth.partyId ?? 'system',
    },
  });

  // Materialise one item per active affiliation in scope. `application` scope
  // has no per-application access grant in `main.prisma` to enumerate, so it
  // reviews the same population as `all`, tagged with the application id
  // under review — exactly the honesty Principle 7 asks for, stated in the
  // docs rather than papered over with a source that does not exist yet.
  const affiliations = await prisma.affiliation.findMany({
    where: {
      tenantId: auth.tenantId,
      status: 'active',
      ...(input.scope === 'role' ? { roleSlug: input.scopeRef } : {}),
    },
  });

  if (affiliations.length) {
    await prisma.itAccessReviewItem.createMany({
      data: affiliations.map((a) => ({
        tenantId: auth.tenantId,
        reviewId: campaign.id,
        partyId: a.partyId,
        affiliationId: a.id,
        roleSlug: a.roleSlug,
        applicationId: input.scope === 'application' ? input.scopeRef : null,
      })),
    });
  }

  await auditWrite({ action: 'create', subjectType: 'it_access_review', subjectId: campaign.id, after: { recordCode, scope: input.scope, items: affiliations.length } });
  await emit({
    name: EVENTS.IT_ACCESS_REVIEW_OPENED,
    subject: { entityType: 'it_access_review', entityId: campaign.id, recordCode },
    newState: { scope: input.scope, itemCount: affiliations.length },
    impact: { domains: [IT_DOMAIN] },
  });

  return withTransitions({ ...campaign, itemCount: affiliations.length });
}

export interface CampaignFilter {
  status?: string;
}

export async function listCampaigns(filter: CampaignFilter = {}) {
  await assertCan({ resource: RESOURCE, verb: 'view' });
  const auth = currentAuth();
  const rows = await prisma.itAccessReview.findMany({
    where: { tenantId: auth.tenantId, ...(filter.status ? { status: filter.status } : {}) },
    orderBy: { createdAt: 'desc' },
  });
  const counts = await prisma.itAccessReviewItem.groupBy({
    by: ['reviewId'],
    where: { tenantId: auth.tenantId, reviewId: { in: rows.map((r) => r.id) } },
    _count: { _all: true },
  });
  const decided = await prisma.itAccessReviewItem.groupBy({
    by: ['reviewId'],
    where: { tenantId: auth.tenantId, reviewId: { in: rows.map((r) => r.id) }, decidedAt: { not: null } },
    _count: { _all: true },
  });
  return rows.map((r) =>
    withTransitions({
      ...r,
      itemCount: counts.find((c) => c.reviewId === r.id)?._count._all ?? 0,
      decidedCount: decided.find((c) => c.reviewId === r.id)?._count._all ?? 0,
    }),
  );
}

export async function campaignDetail(id: string) {
  const auth = currentAuth();
  const campaign = await prisma.itAccessReview.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!campaign) throw ApiError.notFound('Access review campaign');
  await assertCan({ resource: RESOURCE, verb: 'view' });

  const items = await prisma.itAccessReviewItem.findMany({ where: { tenantId: auth.tenantId, reviewId: id }, orderBy: { createdAt: 'asc' } });
  const partyIds = [...new Set(items.map((i) => i.partyId))];
  const people = partyIds.length ? await prisma.person.findMany({ where: { tenantId: auth.tenantId, id: { in: partyIds } }, select: { id: true, fullName: true } }) : [];
  const nameOf = (partyId: string) => people.find((p) => p.id === partyId)?.fullName ?? partyId;

  return {
    ...withTransitions(campaign),
    items: items.map((i) => ({ ...i, partyName: nameOf(i.partyId) })),
  };
}

function withTransitions<T extends { status: string }>(row: T) {
  return { ...row, availableTransitions: availableTransitions(accessReviewMachine, row.status as AccessReviewState) };
}

// ---------------------------------------------------------------------------
// Decide
// ---------------------------------------------------------------------------

export interface DecideItemInput {
  decision: string;
  note?: string | null;
}

export async function decideItem(reviewId: string, itemId: string, input: DecideItemInput) {
  const auth = currentAuth();
  const campaign = await prisma.itAccessReview.findFirst({ where: { id: reviewId, tenantId: auth.tenantId } });
  if (!campaign) throw ApiError.notFound('Access review campaign');
  await assertCan({ resource: RESOURCE, verb: 'edit' });

  if (campaign.status === 'closed') throw ApiError.conflict(`${campaign.recordCode ?? reviewId} is closed. No further decisions can be recorded on it.`);
  if (!DECISIONS.includes(input.decision)) throw ApiError.badRequest(`Decision must be one of: ${DECISIONS.join(', ')}.`);

  const item = await prisma.itAccessReviewItem.findFirst({ where: { id: itemId, tenantId: auth.tenantId, reviewId } });
  if (!item) throw ApiError.notFound('Access review item');

  // The self-review bar (IT-ACR-001): a reviewer may never decide their own
  // access, named explicitly rather than left to a generic permission denial.
  if (auth.partyId && item.partyId === auth.partyId) {
    throw ApiError.forbidden('Self-review bar: a reviewer may never decide their own access. Someone else on the campaign must review this row.');
  }

  const decided = await prisma.itAccessReviewItem.update({
    where: { id: itemId },
    data: { decision: input.decision, decidedAt: new Date(), reviewerPartyId: auth.partyId, note: input.note ?? null },
  });

  await auditWrite({ action: 'update', subjectType: 'it_access_review_item', subjectId: itemId, before: { decision: item.decision }, after: { decision: input.decision } });
  await emit({
    name: EVENTS.IT_ACCESS_REVIEW_DECIDED,
    subject: { entityType: 'it_access_review_item', entityId: itemId },
    related: [{ relation: 'belongs_to', entityType: 'it_access_review', entityId: reviewId }],
    newState: { decision: input.decision },
    owner: { partyId: item.partyId },
    impact: { domains: [IT_DOMAIN] },
  });

  if (campaign.status === 'open') {
    const to = accessReviewMachine.apply('open', 'START_PROGRESS');
    await prisma.itAccessReview.update({ where: { id: reviewId }, data: { status: to } });
    await auditWrite({ action: 'update', subjectType: 'it_access_review', subjectId: reviewId, before: { status: 'open' }, after: { status: to }, meta: { transition: 'START_PROGRESS' } });
  }

  // A `revoke` decision is a finding for the desk to act on, not a write this
  // workstream makes to `Affiliation` — that model lives outside these files.
  if (input.decision === 'revoke') {
    const opsHead = await resolveOpsHeadPartyId();
    await raiseException({
      code: 'IT_ACR_REVOKE_REQUESTED',
      label: `Access review: revoke ${item.roleSlug ?? 'access'} for ${item.partyId}`,
      severity: 'S2_WARNING',
      subjectType: 'it_access_review_item',
      subjectId: itemId,
      subjectLabel: campaign.recordCode,
      domain: IT_DOMAIN,
      detail: `${campaign.name} (${campaign.recordCode}) recommends revoking access for party ${item.partyId}${item.roleSlug ? ` (role ${item.roleSlug})` : ''}. The affiliation itself is not changed automatically — this needs a deliberate offboarding action.`,
      ownerPartyId: opsHead,
      triggerFingerprint: `it_access_review_revoke_${itemId}`,
    });
  }

  return decided;
}

// ---------------------------------------------------------------------------
// Close
// ---------------------------------------------------------------------------

export async function closeCampaign(id: string) {
  const auth = currentAuth();
  const campaign = await prisma.itAccessReview.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!campaign) throw ApiError.notFound('Access review campaign');
  await assertCan({ resource: RESOURCE, verb: 'edit' });

  const undecided = await prisma.itAccessReviewItem.count({ where: { tenantId: auth.tenantId, reviewId: id, decidedAt: null } });
  if (undecided > 0) {
    throw ApiError.unprocessable(`${undecided} item${undecided === 1 ? '' : 's'} on ${campaign.recordCode ?? id} still has no decision. Every item needs one before the campaign can close.`);
  }

  const from = campaign.status as AccessReviewState;
  if (!accessReviewMachine.can(from, 'CLOSE')) {
    throw ApiError.unprocessable(
      `ItAccessReview is ${from}; CLOSE is not one of its transitions. From here it accepts: ${accessReviewMachine.allowedEvents(from).join(', ') || 'nothing — this is a terminal state'}.`,
    );
  }
  const to = accessReviewMachine.apply(from, 'CLOSE');

  const updated = await prisma.itAccessReview.update({ where: { id }, data: { status: to, closedAt: new Date() } });
  await auditWrite({ action: 'update', subjectType: 'it_access_review', subjectId: id, before: { status: from }, after: { status: to }, meta: { transition: 'CLOSE' } });
  await emit({
    name: EVENTS.IT_ACCESS_REVIEW_CLOSED,
    subject: { entityType: 'it_access_review', entityId: id, recordCode: campaign.recordCode },
    previousState: { status: from },
    newState: { status: to },
    impact: { domains: [IT_DOMAIN] },
  });

  return withTransitions(updated);
}

// ---------------------------------------------------------------------------
// Campaign-overdue ladder (jobs/it/governance.ts calls this)
// ---------------------------------------------------------------------------

export interface CampaignOverdueResult {
  checked: number;
  notified: number;
  skippedIdempotent: number;
}

/**
 * Raises once per campaign, gated on `overdueNotifiedAt` the same way
 * `ItControl.testOverdueNotifiedAt` gates the control-test detector — a
 * plain boolean-crossing (not a multi-rung ladder like the risk/finding
 * detectors), so one flag rather than an array is enough. A campaign that
 * moves off `open`/`in_progress` (or is decided/closed) drops out of the
 * query entirely; nothing here ever clears the flag, because there is no
 * "still overdue, notify again" case this detector is asked to cover.
 */
export async function runCampaignOverdueDetector(now: Date = new Date()): Promise<CampaignOverdueResult> {
  const auth = currentAuth();
  const rows = await prisma.itAccessReview.findMany({ where: { tenantId: auth.tenantId, status: { in: ['open', 'in_progress'] } } });

  let notified = 0;
  let skippedIdempotent = 0;
  for (const row of rows) {
    const daysToDue = Math.ceil((row.dueAt.getTime() - now.getTime()) / 86_400_000);
    const overdue = GOVERNANCE_LADDER_RUNGS.filter((r) => r < 0).some((r) => daysToDue <= r);
    if (!overdue) continue;

    if (row.overdueNotifiedAt) {
      skippedIdempotent += 1;
      continue;
    }

    await raiseException({
      code: 'IT_ACR_CAMPAIGN_OVERDUE',
      label: `${row.name} is overdue`,
      severity: 'S3_HIGH_RISK',
      subjectType: 'it_access_review',
      subjectId: row.id,
      subjectLabel: row.recordCode,
      domain: IT_DOMAIN,
      detail: `${row.name} (${row.recordCode}) was due ${row.dueAt.toISOString().slice(0, 10)} and is still ${row.status}.`,
      ownerPartyId: row.openedById,
      slaDueAt: row.dueAt,
      triggerFingerprint: 'it_access_review_campaign_overdue',
    });
    notified += 1;
    await prisma.itAccessReview.update({ where: { id: row.id }, data: { overdueNotifiedAt: now } });
  }

  return { checked: rows.length, notified, skippedIdempotent };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export async function accessReviewsSummary() {
  await assertCan({ resource: RESOURCE, verb: 'view' });
  const auth = currentAuth();
  const total = await prisma.itAccessReview.count({ where: { tenantId: auth.tenantId } });
  if (total === 0) {
    return { notYetMeasured: true, open: 0, inProgress: 0, closed: 0, overdue: 0 };
  }

  const rows = await prisma.itAccessReview.findMany({ where: { tenantId: auth.tenantId } });
  const now = new Date();
  let open = 0;
  let inProgress = 0;
  let closed = 0;
  let overdue = 0;
  for (const r of rows) {
    if (r.status === 'open') open += 1;
    if (r.status === 'in_progress') inProgress += 1;
    if (r.status === 'closed') closed += 1;
    if (r.status !== 'closed' && r.dueAt < now) overdue += 1;
  }
  return { notYetMeasured: false, open, inProgress, closed, overdue };
}
