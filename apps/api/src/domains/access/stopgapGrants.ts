/**
 * The stopgap IT owner grant (DECISIONS round 24 item c, C-015; ACCESS-MODEL-PLAN Wave 4
 * IT-owner conflict).
 *
 * Until onboarding names an IT admin, the founder may give the IT owner an individual grant
 * set as tenant data. Each row is tagged `to_migrate` (Grant.provenance), so the exceptions
 * view lists it and onboarding retires it. Nothing here is a hardcoded role.
 *
 * Only the current founder creates or retires these rows. The founder is read from the duty,
 * never from a role or a grant: holding grants:create does not make the caller the founder,
 * which is why the duty check follows the grant check and does not replace it.
 *
 * Each write runs in the order CLAUDE.md rule 5 gives: the write, `auditWrite`, `emit`, through
 * the same transaction. A refusal throws before any write, so it leaves the grants as they were.
 */

import type { Grant } from '@prisma/client';
import type { Scope, Verb } from '@kaizen/shared';
import { EVENTS } from '@kaizen/shared';
import { prisma, type DbTx } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { assertCan, invalidateGrantCache } from '../../platform/permissions.js';
import { auditWrite } from '../../platform/audit.js';
import { emit } from '../../platform/eventBus.js';
import { governedWrite } from '../../platform/governedWrite.js';
import { ApiError } from '../../platform/errors.js';
import { isFounder } from '../statutory.js';

/** The only provenance a stopgap grant may carry. The database refuses any other value (CHECK). */
export const STOPGAP_PROVENANCE = 'to_migrate';

export const STOPGAP_VERBS = [
  'view',
  'create',
  'edit',
  'delete',
  'assign',
  'export',
  'financial',
  'approve',
  'merge',
] as const;

export interface StopgapGrantSpec {
  resource: string;
  verbs: Verb[];
  scope: Scope;
}

export interface CreateStopgapGrantInput {
  /** The Person the grant set is for. The IT owner's person, not a user or a role. */
  personId: string;
  provenance: string;
  grants: StopgapGrantSpec[];
}

/** Grants still in force at the instant: never ended, or ended after it. */
function inForce(now: Date) {
  return [{ effectiveTo: null }, { effectiveTo: { gt: now } }];
}

function requireFounderOr403(founder: boolean): void {
  if (!founder) {
    throw new ApiError(403, 'FORBIDDEN', 'Only the founder can create or retire a stopgap IT owner grant.', {
      reasonCode: 'founder_only',
    });
  }
}

export async function createStopgapGrant(input: CreateStopgapGrantInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'grants', verb: 'create' });
  const now = new Date();
  requireFounderOr403(await isFounder(now));

  if (input.provenance !== STOPGAP_PROVENANCE) {
    throw ApiError.badRequest(
      `A stopgap grant is tagged '${STOPGAP_PROVENANCE}'. No other provenance is accepted here.`,
    );
  }
  if (input.grants.length === 0) throw ApiError.badRequest('A stopgap grant set needs at least one grant.');

  const person = await prisma.person.findFirst({ where: { id: input.personId } });
  if (!person) throw ApiError.notFound('Person');

  // One in-force stopgap per resource. A second would be two rows answering one question, and
  // retiring one would leave the other behind as a grant nobody meant to keep.
  const clash = await prisma.grant.findFirst({
    where: {
      tenantId: auth.tenantId,
      provenance: STOPGAP_PROVENANCE,
      principalType: 'individual',
      principalId: person.id,
      resource: { in: input.grants.map((g) => g.resource) },
      OR: inForce(now),
    },
    select: { resource: true },
  });
  if (clash) {
    throw ApiError.conflict(
      `This person already has an active stopgap grant for ${clash.resource}. Retire the stopgap before creating another.`,
    );
  }

  const rows = await governedWrite(async (tx: DbTx) => {
    const created: Grant[] = [];
    for (const spec of input.grants) {
      const row = await tx.grant.create({
        data: {
          tenantId: auth.tenantId,
          principalType: 'individual',
          principalId: person.id,
          resource: spec.resource,
          verbs: [...spec.verbs],
          scope: spec.scope,
          scopeResolver: null,
          conditions: {},
          provenance: STOPGAP_PROVENANCE,
          effectiveFrom: now,
        },
      });
      await auditWrite({
        tx,
        action: 'create',
        subjectType: 'grant',
        subjectId: row.id,
        after: { resource: row.resource, verbs: row.verbs, scope: row.scope, principalId: person.id },
        meta: { provenance: STOPGAP_PROVENANCE },
      });
      await emit({
        tx,
        name: EVENTS.GRANT_CHANGED,
        subject: { entityType: 'grant', entityId: row.id },
        newState: { resource: row.resource, verbs: row.verbs, scope: row.scope, provenance: STOPGAP_PROVENANCE },
        reason: { note: 'Stopgap IT owner grant, replaced at onboarding' },
        impact: { domains: ['gov'] },
      });
      created.push(row);
    }
    return created;
  });
  invalidateGrantCache();
  return rows;
}

/**
 * The exceptions view for stopgap grants: every `to_migrate` grant still in force. Gated by
 * grants:view, the permission that reads grants, since the view is a list of grants.
 */
export async function listStopgapGrants() {
  const auth = currentAuth();
  await assertCan({ resource: 'grants', verb: 'view' });
  return prisma.grant.findMany({
    where: { tenantId: auth.tenantId, provenance: STOPGAP_PROVENANCE, OR: inForce(new Date()) },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Ends every in-force stopgap grant in the tenant from now. The rows are kept, with effectiveTo
 * set, so the history of who had the stopgap and when stays in the table. Called by onboarding
 * when it names the IT admin; nothing in onboarding calls it yet.
 *
 * Covers only grants whose effectiveFrom has passed. createStopgapGrant always starts a grant at
 * the instant it is made, so none is future-dated; a future-dated row would need its own end date
 * decided, and that is not something this function should guess.
 */
export async function retireStopgapGrants(): Promise<number> {
  const auth = currentAuth();
  await assertCan({ resource: 'grants', verb: 'edit' });
  const now = new Date();
  requireFounderOr403(await isFounder(now));

  const retired = await governedWrite(async (tx: DbTx) => {
    const open = await tx.grant.findMany({
      where: {
        tenantId: auth.tenantId,
        provenance: STOPGAP_PROVENANCE,
        effectiveFrom: { lte: now },
        OR: inForce(now),
      },
      select: { id: true, resource: true, effectiveTo: true },
    });
    for (const grant of open) {
      await tx.grant.update({ where: { id: grant.id }, data: { effectiveTo: now } });
      await auditWrite({
        tx,
        action: 'update',
        subjectType: 'grant',
        subjectId: grant.id,
        before: { effectiveTo: grant.effectiveTo },
        after: { effectiveTo: now },
        meta: { provenance: STOPGAP_PROVENANCE, retired: true },
      });
      await emit({
        tx,
        name: EVENTS.GRANT_CHANGED,
        subject: { entityType: 'grant', entityId: grant.id },
        previousState: { effectiveTo: grant.effectiveTo?.toISOString() ?? null },
        newState: { effectiveTo: now.toISOString(), provenance: STOPGAP_PROVENANCE },
        reason: { note: 'Stopgap IT owner grant retired' },
        impact: { domains: ['gov'] },
      });
    }
    return open.length;
  });
  invalidateGrantCache();
  return retired;
}
