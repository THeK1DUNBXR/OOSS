/**
 * The two bodies the company deals with, and what is true of each.
 *
 * One row per real legal body, forever — the same discipline as PERSON. What
 * changed is that a row now says which of the two it is, and cannot be both:
 *
 *   `institution`  a school or a college. Sends us learners. Has a district, a
 *                  management type, an AISHE code, a head of department.
 *   `organization` a trust, a foundation or a business. Buys training, sponsors
 *                  a cohort, takes our graduates. Has payment terms and a GSTIN.
 *
 * They used to be optional specialisations that could sit on one row together,
 * on the reasoning that a college might also buy training and keeping two
 * records of one legal body is how a CRM starts lying to you. That reasoning
 * was sound about *billing* and wrong about *identity*: the visible result was
 * a single list called "Companies & Colleges" that answered neither "which
 * colleges do we work with" nor "who are our corporate clients", and a product
 * in which a learner, a polytechnic and a manufacturer were all "customers".
 *
 * So the kind is exclusive and enforced, and billing detail — the Account — is
 * available on either, because being invoiced is not an identity. The third
 * party type, the student, is a PERSON and lives in `students.ts`.
 *
 * `institutions:*` and `organizations:*` remain two independent grant families,
 * and now govern two separated lists rather than two facets of one.
 */

import { EVENTS, type ComputedRelationshipStatus } from '@kaizen/shared';
import { prisma } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { ApiError } from '../platform/errors.js';
import { auditWrite } from '../platform/audit.js';
import { assertCan, can } from '../platform/permissions.js';

export const ORGANIZATION_KINDS = ['institution', 'organization'] as const;
export type OrganizationKind = (typeof ORGANIZATION_KINDS)[number];

export interface OrganizationInput {
  /**
   * Which of the two this is. Required, and not changeable afterwards by
   * accident — see `reclassifyOrganization`, which exists for the case where it
   * was written down wrong and asks for a reason.
   */
  kind: OrganizationKind;
  name: string;
  website?: string | null;
  parentOrgId?: string | null;
  tags?: string[];
  ownerPartyId?: string | null;
  locations?: unknown[];
  /**
   * Billing detail. Either kind may carry it: a polytechnic that buys a staff
   * programme is invoiced exactly like a manufacturer.
   */
  account?: AccountInput;
  /**
   * What kind of school or college it is. An institution only — sending this
   * for an organisation is refused rather than ignored, because silently
   * dropping half of what somebody typed is worse than telling them.
   */
  institutionProfile?: InstitutionProfileInput;
}

/** The grant family that governs a body of this kind. */
export function resourceFor(kind: string): 'institutions' | 'organizations' {
  return kind === 'institution' ? 'institutions' : 'organizations';
}

export async function createOrganization(input: OrganizationInput) {
  const auth = currentAuth();
  const kind: OrganizationKind = input.kind ?? 'organization';
  if (!ORGANIZATION_KINDS.includes(kind)) {
    throw ApiError.badRequest(`A body is either an institution or an organisation, not "${kind}".`);
  }
  // A college is created under `institutions:create` and a business under
  // `organizations:create`. Somebody who may record colleges is not thereby
  // allowed to open corporate accounts.
  await assertCan({ resource: resourceFor(kind), verb: 'create' });

  if (kind !== 'institution' && input.institutionProfile) {
    throw ApiError.badRequest(
      'School and college details belong to an institution. Record this as an institution, or leave those details off.',
    );
  }

  const recordCode = await nextRecordCode('ORG');
  const org = await prisma.organization.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      kind,
      name: input.name,
      website: input.website ?? null,
      parentOrgId: input.parentOrgId ?? null,
      tags: input.tags ?? [],
      ownerPartyId: input.ownerPartyId ?? null,
      locations: (input.locations ?? []) as never,
    },
  });

  await auditWrite({
    action: 'create',
    subjectType: 'organization',
    subjectId: org.id,
    after: { name: org.name, kind: org.kind },
  });
  await emit({
    name: EVENTS.CRM_ORGANIZATION_CREATED,
    subject: { entityType: 'organization', entityId: org.id, recordCode },
    newState: { name: org.name, kind: org.kind },
  });

  // Attached through the same functions the standalone endpoints call, so the
  // grant checks, the audit record and the event are identical whether the
  // detail arrives now or a month later.
  if (input.account) await attachAccount(org.id, input.account);
  if (input.institutionProfile) await attachInstitutionProfile(org.id, input.institutionProfile);

  return org;
}

/**
 * It was written down as the wrong kind.
 *
 * Not an edit like any other: everything downstream reads the kind, so it asks
 * for a reason and refuses where the row has already grown detail that belongs
 * to what it currently is. A college with students against it is not quietly
 * turned into a supplier.
 */
export async function reclassifyOrganization(id: string, kind: OrganizationKind, reason: string) {
  const org = await prisma.organization.findFirst({ where: { id, deletedAt: null } });
  if (!org) throw ApiError.notFound('Organization');
  if (org.kind === kind) return org;
  if (!reason || reason.trim().length < 5) {
    throw ApiError.badRequest('Changing what a body is needs a reason, so the audit trail says why.');
  }

  // Both sides of the change, because it is both a removal and an addition.
  await assertCan({ resource: resourceFor(org.kind), verb: 'edit' });
  await assertCan({ resource: resourceFor(kind), verb: 'create' });

  if (org.kind === 'institution') {
    const [sent, students] = await Promise.all([
      prisma.enrollment.count({ where: { institutionId: id } }),
      prisma.studentProfile.count({ where: { institutionId: id, deletedAt: null } }),
    ]);
    const attached = sent + students;
    if (attached > 0) {
      throw ApiError.conflict(
        `Cannot reclassify: ${attached} student record${attached === 1 ? '' : 's'} name this as the college they came from.`,
        { blockingCount: attached },
      );
    }
    const profile = await prisma.institutionProfile.findFirst({ where: { organizationId: id } });
    if (profile) await prisma.institutionProfile.delete({ where: { id: profile.id } });
  }

  const updated = await prisma.organization.update({ where: { id }, data: { kind } });
  await auditWrite({
    action: 'update',
    subjectType: 'organization',
    subjectId: id,
    before: { kind: org.kind },
    after: { kind, reason },
  });
  return updated;
}

export interface AccountInput {
  tier?: string;
  ownerPartyId?: string | null;
  billingEmail?: string | null;
  billingAddress?: string | null;
  paymentTermsDays?: number | null;
  annualRevenueBand?: string | null;
  employeeCountBand?: string | null;
}

/**
 * Give a body billing detail: terms, where the invoice goes, the registration
 * the tax is charged under.
 *
 * Either kind may have it. A college that buys a staff programme is invoiced
 * like anyone else, and refusing it payment terms because it is a college was
 * the sort of rule that makes people keep a second record in a spreadsheet.
 * The grant checked is the one for what the body *is*, so recording colleges
 * does not let somebody open corporate accounts and the reverse.
 */
export async function attachAccount(organizationId: string, input: AccountInput) {
  const auth = currentAuth();

  const org = await prisma.organization.findFirst({ where: { id: organizationId } });
  if (!org) throw ApiError.notFound('Organization');
  await assertCan({ resource: resourceFor(org.kind), verb: 'create' });

  const existing = await prisma.account.findFirst({ where: { organizationId } });
  if (existing) throw ApiError.conflict('This body already has billing details.');

  const account = await prisma.account.create({
    data: {
      tenantId: auth.tenantId,
      organizationId,
      tier: input.tier ?? 'standard',
      ownerPartyId: input.ownerPartyId ?? org.ownerPartyId,
      billingEmail: input.billingEmail ?? null,
      billingAddress: input.billingAddress ?? null,
      paymentTermsDays: input.paymentTermsDays ?? 30,
      annualRevenueBand: input.annualRevenueBand ?? null,
      employeeCountBand: input.employeeCountBand ?? null,
      attachedById: auth.partyId,
    },
  });

  await auditWrite({ action: 'create', subjectType: 'account', subjectId: account.id, after: { tier: account.tier } });
  await emit({
    name: EVENTS.ACCOUNT_ATTACHED,
    subject: { entityType: 'account', entityId: account.id },
    related: [{ relation: 'specialises', entityType: 'organization', entityId: organizationId }],
    newState: { tier: account.tier },
  });

  return account;
}

export interface InstitutionProfileInput {
  institutionType?: string | null;
  managementType?: string | null;
  address?: string | null;
  district?: string | null;
  taluk?: string | null;
  state?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  externalIdentifier?: string | null;
  establishedYear?: number | null;
  studentCount?: number | null;
  departments?: string[];
  strategicPriority?: string | null;
}

/**
 * School and college detail: what kind it is, who runs it, where it is, its
 * AISHE or UDISE+ code.
 *
 * Institutions only. Requires `institutions:create`, never `organizations:*`.
 */
export async function attachInstitutionProfile(organizationId: string, input: InstitutionProfileInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'institutions', verb: 'create' });

  const org = await prisma.organization.findFirst({ where: { id: organizationId } });
  if (!org) throw ApiError.notFound('Organization');
  if (org.kind !== 'institution') {
    throw ApiError.badRequest(
      `${org.name} is recorded as an organisation, not a school or a college, so it cannot carry institution details. Reclassify it first if that is wrong.`,
    );
  }

  const existing = await prisma.institutionProfile.findFirst({ where: { organizationId } });
  if (existing) throw ApiError.conflict('This institution already has its school or college details.');

  const profile = await prisma.institutionProfile.create({
    data: {
      tenantId: auth.tenantId,
      organizationId,
      institutionType: input.institutionType ?? null,
      managementType: input.managementType ?? null,
      address: input.address ?? null,
      district: input.district ?? null,
      taluk: input.taluk ?? null,
      state: input.state ?? null,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      // Never fabricated — left null instead.
      externalIdentifier: input.externalIdentifier ?? null,
      establishedYear: input.establishedYear ?? null,
      studentCount: input.studentCount ?? null,
      departments: input.departments ?? [],
      strategicPriority: input.strategicPriority ?? null,
      attachedById: auth.partyId,
    },
  });

  await auditWrite({
    action: 'create',
    subjectType: 'institution_profile',
    subjectId: profile.id,
    after: { district: profile.district },
  });
  await emit({
    name: EVENTS.INSTITUTION_PROFILE_ATTACHED,
    subject: { entityType: 'institution_profile', entityId: profile.id },
    related: [{ relation: 'specialises', entityType: 'organization', entityId: organizationId }],
    newState: { institutionType: profile.institutionType, district: profile.district },
  });

  return profile;
}

/**
 * A detach that would orphan referencing records is blocked with a specific
 * error, never a silent cascade-delete.
 */
export async function detachAccount(organizationId: string) {
  const org = await prisma.organization.findFirst({ where: { id: organizationId } });
  if (!org) throw ApiError.notFound('Organization');
  await assertCan({ resource: resourceFor(org.kind), verb: 'delete' });

  const openOpps = await prisma.opportunity.count({
    where: { organizationId, deletedAt: null, outcome: null },
  });
  if (openOpps > 0) {
    throw ApiError.conflict(
      `Cannot remove the billing details: ${openOpps} open opportunit${openOpps === 1 ? 'y' : 'ies'} reference them. Close or reassign them first.`,
      { blockingCount: openOpps },
    );
  }

  const account = await prisma.account.findFirst({ where: { organizationId } });
  if (!account) throw ApiError.notFound('Billing details');

  await prisma.account.delete({ where: { id: account.id } });
  await emit({
    name: EVENTS.ACCOUNT_DETACHED,
    subject: { entityType: 'account', entityId: account.id },
    related: [{ relation: 'specialised', entityType: 'organization', entityId: organizationId }],
  });
  return { detached: true };
}

/**
 * Assembles the 360 view of one body, whichever kind it is.
 *
 * The grant checked to open it at all is the one for its kind, so a viewer who
 * may see colleges and not corporate accounts gets a 404 on a business rather
 * than a partial record of one. Within an institution, its school detail
 * resolves through `institutions` independently, per field: a viewer without
 * that grant sees the badge — the fact of it is not itself sensitive — with the
 * contents withheld under a `no_permission` reason code, never merged or
 * ambiguous.
 */
export async function assembleOrganization360(organizationId: string) {
  const org = await prisma.organization.findFirst({
    where: { id: organizationId, deletedAt: null },
    include: { account: true, institutionProfile: true },
  });
  if (!org) throw ApiError.notFound('Organization');

  const [canSeeKind, canSeeInstitution] = await Promise.all([
    can({ resource: resourceFor(org.kind), verb: 'view' }),
    can({ resource: 'institutions', verb: 'view' }),
  ]);

  // A body of a kind you hold no grant on is not yours to know about, so this
  // reads as "no such record" rather than as "there is one and you may not see
  // it" — the same answer a cross-tenant id gets.
  if (!canSeeKind) throw ApiError.notFound(org.kind === 'institution' ? 'Institution' : 'Organization');

  const withheld: Array<{ path: string; reason: 'no_permission' }> = [];
  let institutionProfile = org.institutionProfile;
  if (institutionProfile && !canSeeInstitution) {
    withheld.push({ path: 'institutionProfile', reason: 'no_permission' });
    institutionProfile = null;
  }

  const computedStatus = await computeRelationshipStatus(organizationId);

  // Students recruited out of this college.
  //
  // A college's page used to say what we knew *about* the college and nothing
  // about what the relationship has actually produced, which is the only reason
  // the relationship exists. Absent for a body that is not a college, and for a
  // viewer without a grant on education — an empty list and "you may not see
  // this" are different answers, so the key is absent rather than empty.
  let students: Array<{
    id: string;
    recordCode: string;
    personName: string | null;
    cohortName: string;
    status: string;
    enrolledAt: string | null;
  }> | null = null;

  if (org.kind === 'institution' && (await can({ resource: 'education', verb: 'view' }))) {
    const enrollments = await prisma.enrollment.findMany({
      where: { tenantId: org.tenantId, institutionId: organizationId },
      include: { cohort: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const people = enrollments.length
      ? await prisma.person.findMany({
          where: { id: { in: [...new Set(enrollments.map((e) => e.personId))] } },
          select: { id: true, fullName: true },
        })
      : [];
    const byId = new Map(people.map((pp) => [pp.id, pp.fullName]));
    students = enrollments.map((e) => ({
      id: e.id,
      recordCode: e.recordCode,
      personName: byId.get(e.personId) ?? null,
      cohortName: e.cohort.name,
      status: e.status,
      enrolledAt: e.enrolledAt?.toISOString() ?? null,
    }));
  }

  return {
    organization: org,
    kind: org.kind,
    account: org.account,
    institutionProfile,
    students,
    specialisations: [
      ...(org.account ? [{ kind: 'account' as const, present: true as const, viewable: true }] : []),
      ...(org.institutionProfile
        ? [{ kind: 'institution_profile' as const, present: true as const, viewable: canSeeInstitution }]
        : []),
    ],
    computedRelationshipStatus: computedStatus,
    withheld,
  };
}

/**
 * Computed at query time from live aggregations across Relationship,
 * Interaction, MoU and Opportunity — never stored on the row itself, because
 * storing it would create a value that drifts from its evidence.
 */
export async function computeRelationshipStatus(organizationId: string): Promise<ComputedRelationshipStatus> {
  const auth = currentAuth();

  const [activeMou, openOpp, relationship, recentInteraction] = await Promise.all([
    prisma.mou.count({
      where: { tenantId: auth.tenantId, organizationId, status: { in: ['signed', 'active', 'expiring'] }, deletedAt: null },
    }),
    prisma.opportunity.count({
      where: { tenantId: auth.tenantId, organizationId, outcome: null, deletedAt: null },
    }),
    prisma.relationship.count({
      where: {
        tenantId: auth.tenantId,
        status: 'active',
        OR: [
          { toType: 'organization', toId: organizationId },
          { fromType: 'organization', fromId: organizationId },
        ],
      },
    }),
    prisma.interaction.count({
      where: {
        tenantId: auth.tenantId,
        deletedAt: null,
        occurredAt: { gte: new Date(Date.now() - 180 * 86_400_000) },
      },
    }),
  ]);

  // Precedence, highest first. A terminated or expired instrument is excluded
  // from "active commitment" identically to an expired one.
  if (activeMou > 0) return 'mou';
  if (openOpp > 0) return 'active_opportunity';
  if (relationship > 0) return 'active_relationship';
  if (recentInteraction > 0) return 'contacted';
  return 'prospect';
}

/**
 * Any service or report that branched on `category === 'institution'` tests
 * `institutionProfile !== null` instead.
 */
export async function isInstitution(organizationId: string): Promise<boolean> {
  const profile = await prisma.institutionProfile.findFirst({
    where: { organizationId },
    select: { id: true },
  });
  return profile !== null;
}
