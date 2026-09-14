/**
 * INTERACTION — the universal join table, and the platform's reference
 * implementation for per-record, per-viewer visibility on a shared collection.
 *
 * `sensitivityClass` is NOT set by the logging user. It is computed as the
 * maximum classification across every entity in relatedReferences, resolved via
 * each target context's own registration — and re-evaluated at every read, so a
 * referenced record's reclassification is reflected on the very next read with
 * zero batch rewrite of historical rows.
 *
 * The highest classification among its references always wins outright: no
 * averaging, no "primary reference" carve-out that would let a routine
 * reference dilute a sensitive one.
 */

import {
  EVENTS,
  SENSITIVITY_RANK,
  maxSensitivity,
  type InteractionType,
  type SensitivityClass,
  type WithholdReason,
} from '@kaizen/shared';
import { prisma } from '../platform/db.js';
import { currentAuth, type AuthContext } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { ApiError } from '../platform/errors.js';
import { auditWrite, auditRegulatedRead } from '../platform/audit.js';
import { assertCan, can, holdsScopeResolver } from '../platform/permissions.js';
import { raiseException } from '../platform/exceptions.js';

export interface RelatedReference {
  contextCode: string;
  entityType: string;
  entityId: string;
  displayLabel?: string | null;
  recordCode?: string | null;
}

/**
 * Entity types whose EXISTENCE is itself the sensitive fact. An interaction
 * touching one of these is concealed — absent from the payload, the schema, and
 * any count — for any viewer outside a narrow need-to-know set, with NO
 * withheld[] entry produced, because recording "one item withheld here" would
 * itself be the leak.
 */
const CONCEALED_ENTITY_TYPES = new Set(['ICC_CASE', 'POSH_CASE', 'WHISTLEBLOWER_REPORT', 'DISCIPLINARY_CASE']);

/**
 * Resolves the registered classification of a target entity type. An unregistered
 * type defaults to `confidential`, NOT `internal`, and raises S1_ATTENTION —
 * defaulting to internal means every new column ships readable.
 */
export async function classificationFor(contextCode: string, entityType: string): Promise<{
  sensitivity: SensitivityClass;
  registered: boolean;
}> {
  const auth = currentAuth();
  const registration = await prisma.sensitivityRegistration.findFirst({
    where: { tenantId: auth.tenantId, contextCode, entityType },
  });

  if (registration) return { sensitivity: registration.sensitivityClass as SensitivityClass, registered: true };
  return { sensitivity: 'confidential', registered: false };
}

/** Computes the class. Runs at write time AND at every read — never cached as a permission decision. */
export async function computeSensitivity(refs: RelatedReference[]): Promise<{
  sensitivityClass: SensitivityClass;
  unregistered: RelatedReference[];
  concealed: boolean;
}> {
  const classes: SensitivityClass[] = [];
  const unregistered: RelatedReference[] = [];
  let concealed = false;

  for (const ref of refs) {
    if (CONCEALED_ENTITY_TYPES.has(ref.entityType)) concealed = true;
    const { sensitivity, registered } = await classificationFor(ref.contextCode, ref.entityType);
    classes.push(sensitivity);
    if (!registered) unregistered.push(ref);
  }

  // A single interaction referencing specific named entities, rather than an
  // aggregate, never qualifies for the k=5 aggregation exception.
  return { sensitivityClass: maxSensitivity(classes), unregistered, concealed };
}

export interface InteractionInput {
  interactionType: InteractionType;
  direction?: string;
  occurredAt: Date;
  relatedReferences: RelatedReference[];
  actorPartyId?: string | null;
  participantPartyIds?: string[];
  durationMinutes?: number | null;
  subject?: string | null;
  notes?: string | null;
  outcome?: string | null;
  nextAction?: string | null;
  nextActionDue?: Date | null;
}

export async function logInteraction(input: InteractionInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'interactions', verb: 'create' });

  if (!input.relatedReferences || input.relatedReferences.length < 1) {
    throw ApiError.unprocessable(
      'An interaction requires at least one related reference. This replaces the seven fixed foreign keys with a validated minimum-length array.',
    );
  }

  // A cross-tenant reference is rejected outright at write time as a
  // data-integrity violation — layered ON TOP of the tenant gate, never in
  // place of it.
  for (const ref of input.relatedReferences) {
    const ok = await referenceResolvesInTenant(ref, auth.tenantId);
    if (!ok) {
      throw ApiError.unprocessable(
        `Reference ${ref.entityType}:${ref.entityId} does not resolve within this tenant.`,
        { ref },
      );
    }
  }

  const { sensitivityClass, unregistered } = await computeSensitivity(input.relatedReferences);

  // Fail-closed backstop: an unregistered entity type reaching the shared
  // interaction log before its domain registered a classification is itself a
  // signal, not a silent default.
  for (const ref of unregistered) {
    await raiseException({
      code: 'EX-ACT-001',
      label: 'Unregistered entity type reached the interaction log',
      severity: 'S1_ATTENTION',
      subjectType: 'sensitivity_registration',
      subjectId: `${ref.contextCode}:${ref.entityType}`,
      subjectLabel: `${ref.contextCode}.${ref.entityType}`,
      domain: 'gov',
      detail: `No SENSITIVITY_CLASS registration exists for ${ref.contextCode}.${ref.entityType}. Defaulted to confidential (fail-closed).`,
      ownerPartyId: auth.partyId,
      reasonCode: 'unregistered_entity_type',
      triggerFingerprint: `unregistered:${ref.contextCode}:${ref.entityType}`,
      ladderRung: 1,
    });
  }

  const recordCode = await nextRecordCode('INT');
  const interaction = await prisma.interaction.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      interactionType: input.interactionType,
      direction: input.direction ?? 'outbound',
      occurredAt: input.occurredAt,
      actorPartyId: input.actorPartyId ?? auth.partyId,
      participantPartyIds: input.participantPartyIds ?? [],
      durationMinutes: input.durationMinutes ?? null,
      subject: input.subject ?? null,
      notes: input.notes ?? null,
      outcome: input.outcome ?? null,
      relatedReferences: input.relatedReferences as never,
      // Persisted denormalised for indexing and reporting only — never
      // authoritative for a permission decision, which recomputes at read.
      sensitivityClass,
      nextAction: input.nextAction ?? null,
      nextActionDue: input.nextActionDue ?? null,
      createdById: auth.partyId,
    },
  });

  // next_action still auto-creates a Task, now linked via relatedInteractionId.
  if (input.nextAction) {
    const taskCode = await nextRecordCode('TSK');
    await prisma.task.create({
      data: {
        tenantId: auth.tenantId,
        recordCode: taskCode,
        title: input.nextAction,
        assigneePartyId: input.actorPartyId ?? auth.partyId,
        ownerPartyId: input.actorPartyId ?? auth.partyId,
        dueAt: input.nextActionDue ?? null,
        relatedInteractionId: interaction.id,
        relatedType: input.relatedReferences[0].entityType,
        relatedId: input.relatedReferences[0].entityId,
        createdById: auth.partyId,
      },
    });
    await emit({
      name: EVENTS.TASK_CREATED,
      subject: { entityType: 'task', entityId: interaction.id, recordCode: taskCode },
      newState: { title: input.nextAction, dueAt: input.nextActionDue },
    });
  }

  // Interaction joins GOVERNED_ENTITIES from creation, unlike the Activity it
  // replaces, whose writes were unaudited.
  await auditWrite({
    action: 'create',
    subjectType: 'interaction',
    subjectId: interaction.id,
    after: { interactionType: input.interactionType, sensitivityClass },
  });

  // Touch the lead's last-interaction marker so the untouched detector is
  // driven by real interaction facts.
  const leadRef = input.relatedReferences.find((r) => r.entityType === 'lead');
  if (leadRef) {
    await prisma.lead.updateMany({
      where: { id: leadRef.entityId },
      data: { lastInteractionAt: input.occurredAt, untouchedNotifiedAt: null },
    });
  }

  await emit({
    name: EVENTS.INTERACTION_LOGGED,
    subject: { entityType: 'interaction', entityId: interaction.id, recordCode },
    related: input.relatedReferences.map((r) => ({
      relation: 'about',
      entityType: r.entityType,
      entityId: r.entityId,
    })),
    newState: { interactionType: input.interactionType, outcome: input.outcome ?? null },
    confidentiality: sensitivityClass,
  });

  return interaction;
}

async function referenceResolvesInTenant(ref: RelatedReference, tenantId: string): Promise<boolean> {
  const table: Record<string, (id: string) => Promise<unknown>> = {
    person: (id) => prisma.person.findFirst({ where: { id, tenantId }, select: { id: true } }),
    organization: (id) => prisma.organization.findFirst({ where: { id, tenantId }, select: { id: true } }),
    lead: (id) => prisma.lead.findFirst({ where: { id, tenantId }, select: { id: true } }),
    opportunity: (id) => prisma.opportunity.findFirst({ where: { id, tenantId }, select: { id: true } }),
    mou: (id) => prisma.mou.findFirst({ where: { id, tenantId }, select: { id: true } }),
    contract: (id) => prisma.contract.findFirst({ where: { id, tenantId }, select: { id: true } }),
    project: (id) => prisma.project.findFirst({ where: { id, tenantId }, select: { id: true } }),
    enrollment: (id) => prisma.enrollment.findFirst({ where: { id, tenantId }, select: { id: true } }),
    account: (id) => prisma.account.findFirst({ where: { id, tenantId }, select: { id: true } }),
    institution_profile: (id) => prisma.institutionProfile.findFirst({ where: { id, tenantId }, select: { id: true } }),
    marketing_campaign: (id) => prisma.marketingCampaign.findFirst({ where: { id, tenantId }, select: { id: true } }),
    marketing_event: (id) => prisma.marketingEvent.findFirst({ where: { id, tenantId }, select: { id: true } }),
  };

  const resolver = table[ref.entityType];
  // An entity type from a domain not yet built asserts rather than joins, per
  // the no-cross-reads rule; it is not treated as a failure.
  if (!resolver) return true;
  return (await resolver(ref.entityId)) !== null;
}

// ---------------------------------------------------------------------------
// The visibility test: WHAT-axis ceiling AND WHERE-axis scope. Both must pass.
// ---------------------------------------------------------------------------

export interface VisibleInteraction {
  id: string;
  recordCode: string;
  interactionType: string;
  direction: string;
  occurredAt: Date;
  durationMinutes: number | null;
  subject: string | null;
  notes: string | null;
  outcome: string | null;
  actorPartyId: string | null;
  participantPartyIds: string[];
  relatedReferences: RelatedReference[];
  sensitivityClass: SensitivityClass;
  nextAction: string | null;
  nextActionDue: Date | null;
  withheld: Array<{ path: string; reason: WithholdReason }>;
}

/**
 * A role that is not narrowed by record-level classification says so through
 * its own classification ceiling — founder, chairman and admin carry
 * `regulated`, which clears every class by construction. There is deliberately
 * no second, role-named escape hatch beside the ceiling: one would let a role
 * whose ceiling had been lowered keep reading above it.
 */
function clearsClassification(auth: AuthContext, cls: SensitivityClass): boolean {
  return SENSITIVITY_RANK[auth.classificationCeiling] >= SENSITIVITY_RANK[cls];
}

export async function timelineFor(
  entityType: string,
  entityId: string,
  opts: { limit?: number } = {},
): Promise<{ items: VisibleInteraction[]; concealedCount: number }> {
  const auth = currentAuth();
  await assertCan({ resource: 'interactions', verb: 'view' });

  const rows = await prisma.interaction.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null },
    orderBy: { occurredAt: 'desc' },
    take: (opts.limit ?? 100) * 3,
  });

  const matching = rows.filter((r) =>
    ((r.relatedReferences as unknown as RelatedReference[]) ?? []).some(
      (ref) => ref.entityType === entityType && ref.entityId === entityId,
    ),
  );

  const visible: VisibleInteraction[] = [];
  const regulatedReads: Array<{ id: string; fields: string[] }> = [];

  for (const row of matching.slice(0, opts.limit ?? 100)) {
    const refs = (row.relatedReferences as unknown as RelatedReference[]) ?? [];
    // Re-evaluated at every read: if a referenced record's classification
    // changed since the interaction was logged, this reflects it now.
    const { sensitivityClass, concealed } = await computeSensitivity(refs);

    // Concealing: absent from the payload, the schema, and any count. No
    // withheld[] entry is produced.
    if (concealed && !(await isNeedToKnow(auth, row))) continue;

    // The whole-record decision: WHAT-axis ceiling.
    const clears = clearsClassification(auth, sensitivityClass);
    if (!clears) continue;

    // WHERE-axis: where the higher classification implies a scoped audience,
    // the viewer must also be in scope. Both axes must pass. A ceiling at or
    // above `regulated` is the platform's top class, so scoping adds nothing.
    const unrestrictedCeiling = auth.classificationCeiling === 'regulated';
    if (SENSITIVITY_RANK[sensitivityClass] >= SENSITIVITY_RANK.confidential && !unrestrictedCeiling) {
      const inScope =
        row.actorPartyId === auth.partyId ||
        row.participantPartyIds.includes(auth.partyId ?? '') ||
        (await inManagementChain(auth, row.actorPartyId));
      if (!inScope) continue;
    }

    // Below the whole-record decision, per-field withholding applies.
    const withheld: Array<{ path: string; reason: WithholdReason }> = [];
    let notes = row.notes;
    if (
      SENSITIVITY_RANK[sensitivityClass] >= SENSITIVITY_RANK.restricted &&
      !unrestrictedCeiling &&
      row.actorPartyId !== auth.partyId
    ) {
      // Withholding: the field is present with a reason code instead of a value.
      notes = null;
      withheld.push({ path: 'notes', reason: 'classification_ceiling' });
    }

    if (sensitivityClass === 'regulated') {
      regulatedReads.push({ id: row.id, fields: ['notes', 'subject'] });
    }

    visible.push({
      id: row.id,
      recordCode: row.recordCode,
      interactionType: row.interactionType,
      direction: row.direction,
      occurredAt: row.occurredAt,
      durationMinutes: row.durationMinutes,
      subject: row.subject,
      notes,
      outcome: row.outcome,
      actorPartyId: row.actorPartyId,
      participantPartyIds: row.participantPartyIds,
      relatedReferences: refs,
      sensitivityClass,
      nextAction: row.nextAction,
      nextActionDue: row.nextActionDue,
      withheld,
    });
  }

  // Every read of a regulated-classified interaction produces an AUDIT_RECORD —
  // never an event.
  for (const r of regulatedReads) {
    await auditRegulatedRead('interaction', r.id, r.fields);
  }

  return { items: visible, concealedCount: 0 };
}

/**
 * Need-to-know is a grant, not a role. `restricted_interactions:view` is what
 * confers it; a principal holding it is need-to-know and one that does not is
 * not, whatever their role slug happens to be. A tenant that wants a fourth
 * role to hold it edits the matrix, not this file.
 */
async function isNeedToKnow(auth: AuthContext, _row: unknown): Promise<boolean> {
  return can({ resource: 'restricted_interactions', verb: 'view', auth });
}

async function inManagementChain(auth: AuthContext, subjectPartyId: string | null): Promise<boolean> {
  if (!subjectPartyId || !auth.partyId) return false;
  const affiliation = await prisma.affiliation.findFirst({
    where: { tenantId: auth.tenantId, partyId: subjectPartyId, status: 'active' },
    select: { orgUnitId: true },
  });
  if (!affiliation?.orgUnitId) return false;
  const viewer = await prisma.affiliation.findFirst({
    where: { tenantId: auth.tenantId, partyId: auth.partyId, status: 'active', orgUnitId: affiliation.orgUnitId },
    select: { id: true },
  });
  if (!viewer) return false;
  // Sharing the org unit is necessary but not sufficient: the caller must also
  // hold the interactions grant marked with the `management_chain` resolver,
  // which is where the set of supervisory roles is declared.
  return holdsScopeResolver('interactions', 'view', 'management_chain', auth);
}

export async function recentInteractions(limit = 50) {
  const auth = currentAuth();
  await assertCan({ resource: 'interactions', verb: 'view' });

  const rows = await prisma.interaction.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null },
    orderBy: { occurredAt: 'desc' },
    take: limit * 2,
  });

  const out: VisibleInteraction[] = [];
  for (const row of rows) {
    const refs = (row.relatedReferences as unknown as RelatedReference[]) ?? [];
    const { sensitivityClass, concealed } = await computeSensitivity(refs);
    if (concealed && !(await isNeedToKnow(auth, row))) continue;

    if (!clearsClassification(auth, sensitivityClass)) continue;

    out.push({
      id: row.id,
      recordCode: row.recordCode,
      interactionType: row.interactionType,
      direction: row.direction,
      occurredAt: row.occurredAt,
      durationMinutes: row.durationMinutes,
      subject: row.subject,
      notes: row.notes,
      outcome: row.outcome,
      actorPartyId: row.actorPartyId,
      participantPartyIds: row.participantPartyIds,
      relatedReferences: refs,
      sensitivityClass,
      nextAction: row.nextAction,
      nextActionDue: row.nextActionDue,
      withheld: [],
    });
    if (out.length >= limit) break;
  }
  return out;
}
