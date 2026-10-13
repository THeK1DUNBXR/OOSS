/**
 * P1 — Identity: person resolution, dedup-on-create, merge, affiliations.
 *
 * `createPerson` and `findOrCreatePerson` are the ONLY two sanctioned entry
 * points to the people table. No service, job, webhook handler or migration
 * script constructs a Person document directly.
 *
 * The 409-with-candidates pattern prevents identity forking at the only point it
 * can be prevented: creation time.
 */

import { EVENTS, STATUTORY_RETENTION_AFFILIATIONS, type AffiliationType, type DedupCandidate } from '@kaizen/shared';
import { prisma, type DbTx } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { ApiError } from '../platform/errors.js';
import { auditWrite, registerGovernedEntities } from '../platform/audit.js';
import { governedWrite } from '../platform/governedWrite.js';
import { raiseException } from '../platform/exceptions.js';
import { assertCan } from '../platform/permissions.js';
import { assertCanAssignRole } from '../platform/roleAssignment.js';

// A merge candidate's resolution decides whether two person rows become one,
// so every resolution is a governed write like the merge it may trigger.
registerGovernedEntities('crm', ['merge_candidate']);

// ---------------------------------------------------------------------------
// Normalisation. Runs before any lookup, on primary and additional values alike.
// ---------------------------------------------------------------------------

export function normalisePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (!digits) return null;
  // Keep the last 10 digits so +91-98765 43210 and 09876543210 resolve alike.
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export function normaliseEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed || null;
}

export function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  return phone.length <= 4 ? '****' : `${'*'.repeat(phone.length - 4)}${phone.slice(-4)}`;
}

export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const [local, domain] = email.split('@');
  if (!domain) return '****';
  const head = local.slice(0, 1);
  return `${head}${'*'.repeat(Math.max(local.length - 1, 3))}@${domain}`;
}

// ---------------------------------------------------------------------------
// RESOLUTION_SCOPE — a policy configuration object, not a collection. It never
// spans tenants: a human present in two tenants is, by design, two unrelated
// identities.
// ---------------------------------------------------------------------------

export interface ResolutionScope {
  tenantId: string;
  context: string;
  /** A match found outside the declared scope requires human confirmation regardless of confidence. */
  neverAutoMergeStatutoryRetention: true;
}

export function crmResolutionScope(tenantId: string): ResolutionScope {
  return { tenantId, context: 'crm', neverAutoMergeStatutoryRetention: true };
}

export interface PersonInput {
  fullName: string;
  primaryPhone?: string | null;
  primaryEmail?: string | null;
  additionalPhones?: string[];
  additionalEmails?: string[];
  externalIds?: Array<{ system: string; id: string }>;
  notes?: string | null;
  source?: string;
}

/**
 * Exact equality against the normalised phone/email fields, excluding merged
 * rows, scoped by the caller's declared RESOLUTION_SCOPE.
 */
export async function findDedupCandidates(input: PersonInput, scope: ResolutionScope): Promise<DedupCandidate[]> {
  const phone = normalisePhone(input.primaryPhone);
  const email = normaliseEmail(input.primaryEmail);
  const extraPhones = (input.additionalPhones ?? []).map(normalisePhone).filter(Boolean) as string[];
  const extraEmails = (input.additionalEmails ?? []).map(normaliseEmail).filter(Boolean) as string[];

  const phones = [phone, ...extraPhones].filter(Boolean) as string[];
  const emails = [email, ...extraEmails].filter(Boolean) as string[];
  if (phones.length === 0 && emails.length === 0) return [];

  const matches = await prisma.person.findMany({
    where: {
      tenantId: scope.tenantId,
      deletedAt: null,
      // A merged row never matches; the caller falls through to merged_into's
      // target if that target also matches, or to "no match".
      dedupeStatus: { not: 'merged' },
      OR: [
        ...(phones.length ? [{ primaryPhoneNormalised: { in: phones } }] : []),
        ...(emails.length ? [{ primaryEmailNormalised: { in: emails } }] : []),
        ...(phones.length ? [{ additionalPhonesNormalised: { hasSome: phones } }] : []),
        ...(emails.length ? [{ additionalEmailsNormalised: { hasSome: emails } }] : []),
      ],
    },
    include: { affiliations: { where: { status: 'active' } } },
    take: 10,
  });

  return matches.map((m) => {
    const matchedOn: string[] = [];
    if (phone && m.primaryPhoneNormalised === phone) matchedOn.push('primary_phone');
    if (email && m.primaryEmailNormalised === email) matchedOn.push('primary_email');
    if (phones.some((p) => m.additionalPhonesNormalised.includes(p))) matchedOn.push('additional_phone');
    if (emails.some((e) => m.additionalEmailsNormalised.includes(e))) matchedOn.push('additional_email');

    const statutory = m.affiliations.some((a) => a.statutoryRetentionFloor);

    // An exact match is one where every primary identifier the caller supplied
    // matches the same primary field on this candidate. A caller who supplies
    // only a phone and hits that phone exactly has an exact match — the absence
    // of a second identifier is not evidence against the match.
    //
    // A *partial* match — two identifiers supplied, one matching and one not —
    // is the ambiguous case the bias toward false negatives exists for, and is
    // scored below exact so it raises a MERGE_CANDIDATE rather than resolving.
    const suppliedPrimary = [phone, email].filter(Boolean).length;
    const matchedPrimary =
      (phone && m.primaryPhoneNormalised === phone ? 1 : 0) + (email && m.primaryEmailNormalised === email ? 1 : 0);

    const confidence =
      suppliedPrimary > 0 && matchedPrimary === suppliedPrimary
        ? 1
        : matchedPrimary > 0
          ? 0.7
          : matchedOn.length >= 2
            ? 0.9
            : 0.7;

    return {
      personId: m.id,
      recordCode: m.recordCode,
      fullName: m.fullName,
      // Masked: an operator confirming a match needs enough to recognise the
      // person, never the full record if they lack permission on it.
      maskedPhone: maskPhone(m.primaryPhoneNormalised),
      maskedEmail: maskEmail(m.primaryEmailNormalised),
      matchedOn,
      confidence,
      // A CRM role sees "holds a non-CRM affiliation" as a badge, never the
      // HR/education specialisation detail behind it.
      affiliationSummary: m.affiliations.map((a) => a.affiliationType),
      statutoryRetentionFloor: statutory,
      crossScope: false,
    } satisfies DedupCandidate;
  });
}

export interface ResolveResult {
  person: Awaited<ReturnType<typeof prisma.person.findFirstOrThrow>>;
  created: boolean;
  resolved: boolean;
}

/**
 * The only sanctioned path for any flow that needs "a person with these
 * details". Every intake surface — lead capture, admissions enquiry, contact
 * dialog, bulk import, webhook — calls this and handles the 409 identically.
 */
export async function findOrCreatePerson(
  input: PersonInput,
  opts: { forceCreate?: boolean; overrideReason?: string; scope?: ResolutionScope } = {},
): Promise<ResolveResult> {
  const auth = currentAuth();
  const scope = opts.scope ?? crmResolutionScope(auth.tenantId);

  if (!input.primaryPhone && !input.primaryEmail) {
    throw ApiError.badRequest('A person requires at least one of primary_phone or primary_email at creation.');
  }

  const candidates = await findDedupCandidates(input, scope);

  if (candidates.length > 0 && !opts.forceCreate) {
    const exact = candidates.filter((c) => c.confidence === 1);
    const statutory = candidates.filter((c) => c.statutoryRetentionFloor);

    // Exact match, in scope, no statutory-retention-floor affiliation:
    // resolve silently to the existing person, no new row.
    if (exact.length === 1 && statutory.length === 0) {
      const person = await prisma.person.findFirstOrThrow({ where: { id: exact[0].personId } });
      await emit({
        name: EVENTS.PERSON_RESOLVED,
        subject: { entityType: 'person', entityId: person.id, recordCode: person.recordCode },
        newState: { matchedOn: exact[0].matchedOn },
      });
      return { person, created: false, resolved: true };
    }

    // Any ambiguous match, cross-scope match, or match against a candidate
    // holding a statutory-retention-floor affiliation raises MERGE_CANDIDATE —
    // even when the match is exact and in scope. Biased hard toward false
    // negatives.
    const reason = statutory.length > 0 ? 'statutory_retention_floor' : 'ambiguous';
    const top = candidates.reduce((a, b) => (b.confidence > a.confidence ? b : a));

    // The candidate, its audit row and its event commit together: the queue
    // entry a reviewer will act on must have a record of its raising.
    await governedWrite(async (tx) => {
      const mc = await tx.mergeCandidate.create({
        data: {
          tenantId: auth.tenantId,
          incomingPayload: input as never,
          candidatePersonId: top.personId,
          confidence: top.confidence,
          matchedOn: top.matchedOn,
          raisedReason: reason,
        },
      });

      await auditWrite({
        action: 'create',
        subjectType: 'merge_candidate',
        subjectId: mc.id,
        after: { raisedReason: reason, confidence: top.confidence, candidatePersonId: top.personId },
        tx,
      });

      await emit({
        name: EVENTS.MERGE_CANDIDATE_RAISED,
        subject: { entityType: 'merge_candidate', entityId: mc.id },
        related: [{ relation: 'candidate', entityType: 'person', entityId: top.personId }],
        newState: { reason, confidence: top.confidence },
        impact: { domains: ['idn'], severity: 'S1_ATTENTION' },
        tx,
      });
    });

    throw ApiError.duplicate(
      reason === 'statutory_retention_floor'
        ? 'A matching person holds an active employee or student affiliation with a statutory retention floor. This never auto-merges, regardless of confidence.'
        : 'One or more existing people match these details. Confirm the match or explicitly force-create with a reason.',
      candidates,
    );
  }

  const person = await createPerson(input, opts.overrideReason);
  return { person, created: true, resolved: false };
}

/** Creates without a dedup check. Reachable only through findOrCreatePerson. */
async function createPerson(input: PersonInput, overrideReason?: string) {
  return governedWrite(async (tx) => {
    const { person, recordCode } = await insertPersonRow(tx, input);

    await auditWrite({
      action: 'create',
      subjectType: 'person',
      subjectId: person.id,
      after: { fullName: person.fullName, recordCode },
      meta: overrideReason ? { forceCreateReason: overrideReason } : undefined,
      tx,
    });

    await emit({
      name: EVENTS.PERSON_CREATED,
      subject: { entityType: 'person', entityId: person.id, recordCode },
      newState: { fullName: person.fullName },
      reason: overrideReason ? { reasonCode: 'force_create_override', note: overrideReason } : null,
      tx,
    });

    return person;
  });
}

/**
 * The row alone. Split out so a merge-candidate confirmation can write the
 * incoming person inside the transaction that merges it; audit and events stay
 * with the caller, which decides when they may fire.
 */
async function insertPersonRow(db: DbTx, input: PersonInput) {
  const auth = currentAuth();
  const recordCode = await nextRecordCode('PER', new Date(), db);

  const person = await db.person.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      fullName: input.fullName,
      primaryPhone: input.primaryPhone ?? null,
      primaryEmail: input.primaryEmail ?? null,
      primaryPhoneNormalised: normalisePhone(input.primaryPhone),
      primaryEmailNormalised: normaliseEmail(input.primaryEmail),
      additionalPhones: input.additionalPhones ?? [],
      additionalEmails: input.additionalEmails ?? [],
      additionalPhonesNormalised: (input.additionalPhones ?? []).map(normalisePhone).filter(Boolean) as string[],
      additionalEmailsNormalised: (input.additionalEmails ?? []).map(normaliseEmail).filter(Boolean) as string[],
      externalIds: (input.externalIds ?? []) as never,
      notes: input.notes ?? null,
      source: input.source ?? 'manual',
      createdById: auth.partyId,
    },
  });

  return { person, recordCode };
}

/** Exposed so callers can use the sanctioned path explicitly. */
export const sanctionedCreatePerson = createPerson;

/**
 * The merge's writes, with no permission check, audit or event: the caller
 * owns those, and a merge confirmed from a candidate must run them inside the
 * same transaction that closes the candidate.
 */
async function applyPersonMerge(db: DbTx, sourceId: string, targetId: string) {
  const source = await db.person.findFirst({ where: { id: sourceId } });
  const target = await db.person.findFirst({ where: { id: targetId } });
  if (!source || !target) throw ApiError.notFound('Person');

  const updated = await db.person.update({
    where: { id: sourceId },
    data: { dedupeStatus: 'merged', mergedIntoId: targetId },
  });

  // Active affiliations move to the survivor, because they are what the survivor
  // is now working as. Their ids are returned so the merge audit row can name
  // them: the move itself is not reversible from the merged row alone, and an
  // unmerge needs to know which affiliations to put back. Ended ones stay on the
  // merged-away person, and traversal from the surviving id follows the mergedInto
  // chain to assemble the rest of the history.
  const moving = await db.affiliation.findMany({
    where: { partyId: sourceId, status: 'active' },
    select: { id: true },
  });
  const movedAffiliationIds = moving.map((a) => a.id);
  if (movedAffiliationIds.length) {
    await db.affiliation.updateMany({
      where: { id: { in: movedAffiliationIds } },
      data: { partyId: targetId },
    });
  }

  return { source, target, updated, movedAffiliationIds };
}

/**
 * Merge is a distinct, explicit operation, never a side effect of resolution.
 * The merged row is never deleted — its history stays queryable via mergedInto.
 */
export async function mergePersons(sourceId: string, targetId: string, note: string) {
  const auth = currentAuth();

  // A wrong merge is a data-integrity incident, not a routine edit — hence its
  // own grant, held independently of the base people grant.
  await assertCan({ resource: 'people', verb: 'merge' });

  if (sourceId === targetId) throw ApiError.badRequest('Cannot merge a person into itself.');

  // The hard rule preserved verbatim: any merge combining records carrying
  // compensation, performance, disciplinary or background-check data requires
  // human confirmation regardless of confidence score. This path IS the human
  // confirmation; an agent can never reach it.
  if (auth.principalType === 'agent') {
    throw ApiError.forbidden('No AI principal may perform a merge, at any AUTHORITY_GRANT size.');
  }

  const { updated } = await prisma.$transaction(async (tx) => {
    const merged = await applyPersonMerge(tx, sourceId, targetId);

    await auditWrite({
      action: 'merge',
      subjectType: 'person',
      subjectId: sourceId,
      before: { dedupeStatus: merged.source.dedupeStatus },
      after: { dedupeStatus: 'merged', mergedIntoId: targetId },
      meta: { note, targetRecordCode: merged.target.recordCode, movedAffiliationIds: merged.movedAffiliationIds },
      tx,
    });

    await emit({
      name: EVENTS.PERSON_MERGED,
      subject: { entityType: 'person', entityId: sourceId, recordCode: merged.source.recordCode },
      related: [{ relation: 'merged_into', entityType: 'person', entityId: targetId }],
      previousState: { dedupeStatus: merged.source.dedupeStatus },
      newState: { dedupeStatus: 'merged', mergedIntoId: targetId },
      reason: { reasonCode: 'merge_confirmed', note },
      confidentiality: 'restricted',
      tx,
    });

    return merged;
  });

  return updated;
}

/** Full history traversal follows the mergedInto chain from the surviving id. */
export async function personIdChain(personId: string): Promise<string[]> {
  const ids = new Set<string>([personId]);
  let frontier = [personId];
  for (let depth = 0; depth < 8 && frontier.length; depth += 1) {
    const merged = await prisma.person.findMany({
      where: { mergedIntoId: { in: frontier } },
      select: { id: true },
    });
    frontier = merged.map((m) => m.id).filter((id) => !ids.has(id));
    for (const id of frontier) ids.add(id);
  }
  return [...ids];
}

export async function resolveMergeCandidate(id: string, disposition: 'confirm' | 'reject' | 'defer', note: string) {
  const auth = currentAuth();
  // Resolving a candidate is the decision to merge or to keep apart. Holding
  // the queue to the merge grant means nobody can clear it without the right to
  // make the call, and nothing counts as "resolved" that the grant did not cover.
  await assertCan({ resource: 'people', verb: 'merge' });

  const mc = await prisma.mergeCandidate.findFirst({ where: { id } });
  if (!mc) throw ApiError.notFound('Merge candidate');
  if (mc.state !== 'open') throw ApiError.conflict(`Merge candidate is already ${mc.state}.`);

  if (disposition === 'confirm') {
    if (auth.principalType === 'agent') {
      throw ApiError.forbidden('No AI principal may perform a merge, at any AUTHORITY_GRANT size.');
    }
    return confirmMergeCandidate(mc, note);
  }

  // The guard is in the WHERE clause so two resolutions racing on one candidate
  // cannot both pass the state check above.
  const state = disposition === 'reject' ? 'rejected' : 'deferred';
  const now = new Date();
  await governedWrite(async (tx) => {
    const { count } = await tx.mergeCandidate.updateMany({
      where: { id, state: 'open' },
      data:
        disposition === 'reject'
          ? { state, resolvedById: auth.partyId, resolvedAt: now, resolutionNote: note }
          : { state, resolutionNote: note },
    });
    if (count !== 1) throw ApiError.conflict('Merge candidate was resolved by someone else.');

    await auditWrite({
      action: 'update',
      subjectType: 'merge_candidate',
      subjectId: id,
      before: { state: 'open' },
      after: { state },
      meta: { note },
      tx,
    });

    if (disposition === 'reject') {
      await emit({
        name: EVENTS.MERGE_CANDIDATE_REJECTED,
        subject: { entityType: 'merge_candidate', entityId: id },
        related: [{ relation: 'candidate', entityType: 'person', entityId: mc.candidatePersonId }],
        newState: { state },
        reason: { reasonCode: disposition, note },
        tx,
      });
    }
  });

  return prisma.mergeCandidate.findFirstOrThrow({ where: { id } });
}

/**
 * The incoming payload was never a person row: the candidate was raised before
 * anything was written. Confirming therefore writes that person and merges it
 * into the candidate's existing record, which survives. The merged-away row is
 * kept, so the incoming details stay on record after the merge.
 *
 * The candidate's state change, the new row and the merge commit together, or
 * not at all. Otherwise a retry after a partial failure would create a second
 * stray person for the same incoming payload.
 */
async function confirmMergeCandidate(
  mc: { id: string; incomingPayload: unknown; candidatePersonId: string },
  note: string,
) {
  const auth = currentAuth();
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    const { count } = await tx.mergeCandidate.updateMany({
      where: { id: mc.id, state: 'open' },
      data: { state: 'confirmed', resolvedById: auth.partyId, resolvedAt: now, resolutionNote: note },
    });
    if (count !== 1) throw ApiError.conflict('Merge candidate was resolved by someone else.');

    const { person: incoming, recordCode } = await insertPersonRow(tx, mc.incomingPayload as PersonInput);
    const { source, target, movedAffiliationIds } = await applyPersonMerge(tx, incoming.id, mc.candidatePersonId);

    // Audit rows go through this transaction. Written on their own connection,
    // a later failure in this transaction (the emits below, say) would roll the
    // merge back and leave three audit rows describing a merge that never
    // happened. Ordering is still audit before event, as governedWrite requires.
    await auditWrite({
      action: 'create',
      subjectType: 'person',
      subjectId: incoming.id,
      after: { fullName: incoming.fullName, recordCode },
      meta: { mergeCandidateId: mc.id },
      tx,
    });
    await auditWrite({
      action: 'merge',
      subjectType: 'person',
      subjectId: incoming.id,
      before: { dedupeStatus: source.dedupeStatus },
      after: { dedupeStatus: 'merged', mergedIntoId: target.id },
      meta: {
        note,
        targetRecordCode: target.recordCode,
        mergeCandidateId: mc.id,
        movedAffiliationIds,
      },
      tx,
    });
    await auditWrite({
      action: 'update',
      subjectType: 'merge_candidate',
      subjectId: mc.id,
      before: { state: 'open' },
      after: { state: 'confirmed' },
      meta: { note },
      tx,
    });

    // Every audit row above precedes these events (governedWrite.ts), so the
    // events are emitted inside the same transaction once the audits are written.
    await emit({
      name: EVENTS.PERSON_CREATED,
      subject: { entityType: 'person', entityId: incoming.id, recordCode },
      newState: { fullName: incoming.fullName },
      reason: { reasonCode: 'merge_candidate_confirmed', note },
      tx,
    });

    await emit({
      name: EVENTS.PERSON_MERGED,
      subject: { entityType: 'person', entityId: incoming.id, recordCode },
      related: [{ relation: 'merged_into', entityType: 'person', entityId: target.id }],
      previousState: { dedupeStatus: source.dedupeStatus },
      newState: { dedupeStatus: 'merged', mergedIntoId: target.id },
      reason: { reasonCode: 'merge_confirmed', note },
      confidentiality: 'restricted',
      tx,
    });

    await emit({
      name: EVENTS.MERGE_CANDIDATE_CONFIRMED,
      subject: { entityType: 'merge_candidate', entityId: mc.id },
      related: [{ relation: 'candidate', entityType: 'person', entityId: mc.candidatePersonId }],
      newState: { state: 'confirmed' },
      reason: { reasonCode: 'confirm', note },
      tx,
    });
  });

  return prisma.mergeCandidate.findFirstOrThrow({ where: { id: mc.id } });
}

/**
 * An unresolved MERGE_CANDIDATE older than the tenant's configured threshold
 * raises EX-CRM-002 to the record owner, escalating to Admin at 30 days. The
 * queue shows zero items only when zero are actually open.
 */
export async function sweepStaleMergeCandidates(thresholdDays = 14): Promise<number> {
  const auth = currentAuth();
  const cutoff = new Date(Date.now() - thresholdDays * 86_400_000);
  const stale = await prisma.mergeCandidate.findMany({
    where: { tenantId: auth.tenantId, state: 'open', createdAt: { lt: cutoff } },
    take: 200,
  });

  for (const mc of stale) {
    const candidate = await prisma.person.findFirst({ where: { id: mc.candidatePersonId } });
    await raiseException({
      code: 'EX-CRM-002',
      label: 'Possible duplicate person, still unconfirmed',
      severity: 'S1_ATTENTION',
      subjectType: 'merge_candidate',
      subjectId: mc.id,
      subjectLabel: candidate?.fullName ?? mc.candidatePersonId,
      domain: 'idn',
      detail: `Open for more than ${thresholdDays} days. Confirm, reject, or defer explicitly.`,
      ownerPartyId: candidate?.createdById ?? null,
      triggerFingerprint: `merge_candidate_stale:${thresholdDays}`,
      ladderRung: 1,
    });
  }
  return stale.length;
}

// ---------------------------------------------------------------------------
// Affiliations
// ---------------------------------------------------------------------------

export interface AffiliationInput {
  partyId: string;
  affiliationType: AffiliationType;
  counterpartyId?: string | null;
  counterpartyName?: string | null;
  roleSlug?: string | null;
  primaryFlag?: boolean;
  branch?: string | null;
  orgUnitId?: string | null;
  positionId?: string | null;
  effectiveFrom?: Date;
  effectiveTo?: Date | null;
}

export async function createAffiliation(input: AffiliationInput) {
  const auth = currentAuth();
  // An affiliation's role is the access role the evaluator reads for this
  // person, so naming one is granting access. Checked only when a role is
  // named: the education and import callers create affiliations with none,
  // and that is not a grant. people:assign alone is not enough: hr_ops_manager
  // holds it, and without the coverage check it could name chairman and
  // become superadmin. assertCanAssignRole stops self-assignment and any role
  // broader than the caller's own grants.
  if (input.roleSlug) {
    await assertCan({ resource: 'people', verb: 'assign' });
    await assertCanAssignRole({ roleSlug: input.roleSlug, targetPartyId: input.partyId });
  }
  return governedWrite(async (tx) => {
    const affiliation = await tx.affiliation.create({
      data: {
        tenantId: auth.tenantId,
        partyId: input.partyId,
        affiliationType: input.affiliationType,
        counterpartyId: input.counterpartyId ?? null,
        counterpartyName: input.counterpartyName ?? null,
        roleSlug: input.roleSlug ?? null,
        primaryFlag: input.primaryFlag ?? false,
        branch: input.branch ?? null,
        orgUnitId: input.orgUnitId ?? null,
        positionId: input.positionId ?? null,
        effectiveFrom: input.effectiveFrom ?? new Date(),
        effectiveTo: input.effectiveTo ?? null,
        statutoryRetentionFloor: STATUTORY_RETENTION_AFFILIATIONS.includes(input.affiliationType),
      },
    });

    await auditWrite({
      action: 'create',
      subjectType: 'affiliation',
      subjectId: affiliation.id,
      after: { affiliationType: input.affiliationType, roleSlug: input.roleSlug ?? null },
      tx,
    });

    await emit({
      name: EVENTS.AFFILIATION_CREATED,
      subject: { entityType: 'affiliation', entityId: affiliation.id },
      related: [{ relation: 'held_by', entityType: 'person', entityId: input.partyId }],
      newState: { affiliationType: input.affiliationType, roleSlug: input.roleSlug ?? null },
      tx,
    });

    return affiliation;
  });
}

/**
 * A revoked affiliation goes dark on the very next query — there is no
 * deprovisioning job and no session-invalidation step in between, because
 * permission is evaluated at query time from live affiliation state.
 */
export async function endAffiliation(id: string, reason: string) {
  return governedWrite(async (tx) => {
    const affiliation = await tx.affiliation.update({
      where: { id },
      data: { status: 'ended', effectiveTo: new Date() },
    });
    await auditWrite({
      action: 'update',
      subjectType: 'affiliation',
      subjectId: id,
      after: { status: 'ended', effectiveTo: affiliation.effectiveTo },
      meta: { reason },
      tx,
    });
    await emit({
      name: EVENTS.AFFILIATION_ENDED,
      subject: { entityType: 'affiliation', entityId: id },
      newState: { status: 'ended' },
      reason: { reasonCode: 'affiliation_ended', note: reason },
      tx,
    });
    return affiliation;
  });
}
