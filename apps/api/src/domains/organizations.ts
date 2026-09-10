/**
 * Organization and its two independent specialisations (CRM-IDN-002/003).
 *
 * One row per real legal body, forever — the same discipline as PERSON. The
 * exclusivity invariant is gone: nothing about the domain says an institution
 * cannot also be a paying corporate client, a placement employer, or a vendor.
 * Both specialisations may exist on the same row simultaneously, and a third
 * may exist alongside them without conflict.
 *
 * `institutions:*` and `organizations:*` remain two independent grant families.
 * Nothing here collapses them as a side effect of the data becoming more
 * closely related.
 */

import { EVENTS, type ComputedRelationshipStatus } from '@kaizen/shared';
import { prisma } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { ApiError } from '../platform/errors.js';
import { auditWrite } from '../platform/audit.js';
import { assertCan, can } from '../platform/permissions.js';

export interface OrganizationInput {
  name: string;
  website?: string | null;
  parentOrgId?: string | null;
  tags?: string[];
  ownerPartyId?: string | null;
  locations?: unknown[];
  /**
   * What this body is to us, declared at the moment of creation.
   *
   * Both are optional and independent — a college that also buys training
   * carries both, and a body we have only just heard of carries neither. They
   * are here rather than only on their own endpoints because a person adding a
   * college knows it is a college while they are typing its name, and making
   * them save, navigate and press a second button taught them nothing except
   * that the product has an internal model. Each still goes through its own
   * attach function, so each still requires its own grant.
   */
  account?: AccountInput;
  institutionProfile?: InstitutionProfileInput;
}

/** Creating an ORGANIZATION requires only a name. It carries no `category` field. */
export async function createOrganization(input: OrganizationInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'organizations', verb: 'create' });

  const recordCode = await nextRecordCode('ORG');
  const org = await prisma.organization.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      name: input.name,
      website: input.website ?? null,
      parentOrgId: input.parentOrgId ?? null,
      tags: input.tags ?? [],
      ownerPartyId: input.ownerPartyId ?? null,
      locations: (input.locations ?? []) as never,
    },
  });

  await auditWrite({ action: 'create', subjectType: 'organization', subjectId: org.id, after: { name: org.name } });
  await emit({
    name: EVENTS.CRM_ORGANIZATION_CREATED,
    subject: { entityType: 'organization', entityId: org.id, recordCode },
    newState: { name: org.name },
  });

  // Attached through the same functions the standalone endpoints call, so the
  // grant checks, the audit record and the event are identical whether the
  // specialisation arrives now or a month later.
  if (input.account) await attachAccount(org.id, input.account);
  if (input.institutionProfile) await attachInstitutionProfile(org.id, input.institutionProfile);

  return org;
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
 * Attaching an ACCOUNT is a distinct operation from attaching an
 * INSTITUTION_PROFILE. No validation rule anywhere rejects attaching a second
 * specialisation because a first is already present.
 *
 * Attaching an Account requires `organizations:create`, never `institutions:*`.
 */
export async function attachAccount(organizationId: string, input: AccountInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'organizations', verb: 'create' });

  const org = await prisma.organization.findFirst({ where: { id: organizationId } });
  if (!org) throw ApiError.notFound('Organization');

  const existing = await prisma.account.findFirst({ where: { organizationId } });
  if (existing) throw ApiError.conflict('This organization already carries an Account specialisation.');

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

/** Attaching an InstitutionProfile requires `institutions:create`, never `organizations:*`. */
export async function attachInstitutionProfile(organizationId: string, input: InstitutionProfileInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'institutions', verb: 'create' });

  const org = await prisma.organization.findFirst({ where: { id: organizationId } });
  if (!org) throw ApiError.notFound('Organization');

  const existing = await prisma.institutionProfile.findFirst({ where: { organizationId } });
  if (existing) throw ApiError.conflict('This organization already carries an InstitutionProfile specialisation.');

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
  await assertCan({ resource: 'organizations', verb: 'delete' });

  const openOpps = await prisma.opportunity.count({
    where: { organizationId, deletedAt: null, outcome: null },
  });
  if (openOpps > 0) {
    throw ApiError.conflict(
      `Cannot detach the Account specialisation: ${openOpps} open opportunit${openOpps === 1 ? 'y' : 'ies'} reference it. Close or reassign them first.`,
      { blockingCount: openOpps },
    );
  }

  const account = await prisma.account.findFirst({ where: { organizationId } });
  if (!account) throw ApiError.notFound('Account specialisation');

  await prisma.account.delete({ where: { id: account.id } });
  await emit({
    name: EVENTS.ACCOUNT_DETACHED,
    subject: { entityType: 'account', entityId: account.id },
    related: [{ relation: 'specialised', entityType: 'organization', entityId: organizationId }],
  });
  return { detached: true };
}

/**
 * Assembles the 360 view. Each specialisation resolves through its own grant
 * family, evaluated independently, per field. A viewer holding `organizations:V`
 * but no `institutions` grant sees the Institution badge (the fact of the
 * specialisation is not itself sensitive) with its contents withheld under a
 * `no_permission` reason code — never a merged or ambiguous response.
 */
export async function assembleOrganization360(organizationId: string) {
  const org = await prisma.organization.findFirst({
    where: { id: organizationId, deletedAt: null },
    include: { account: true, institutionProfile: true },
  });
  if (!org) throw ApiError.notFound('Organization');

  const [canSeeOrg, canSeeInstitution] = await Promise.all([
    can({ resource: 'organizations', verb: 'view' }),
    can({ resource: 'institutions', verb: 'view' }),
  ]);

  if (!canSeeOrg) throw ApiError.forbidden('organizations:view is not held.');

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

  if (org.institutionProfile && (await can({ resource: 'education', verb: 'view' }))) {
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
