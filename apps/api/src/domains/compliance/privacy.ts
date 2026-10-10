/**
 * Compliance — G. Data protection and privacy (DPDP). docs/plan/compliance.md §G.
 *
 * The WHY axis in `permissions.ts` has always accepted a purpose and a set of
 * consent codes; nothing ever populated them, so `evaluate()` denied every
 * consent requirement outright. This module is what feeds it: a privacy
 * notice naming the purposes the platform actually processes data for, a
 * `Consent` row per purpose per person, a data-principal-request workflow that
 * reasons against the statutory retention floor rather than refusing quietly,
 * a breach register with the 72-hour ladder the DPDP Rules require, field-level
 * encryption for the regulated identifiers HR writes, and an offboarding hook
 * that actually revokes access instead of leaving it to the next live query.
 *
 * `contextMiddleware` (lib/http.ts) calls `grantedConsentCodes` and
 * `resolvePurpose` from this module on every request — that is the whole
 * reason `ctx.auth.consentCodes` stops being permanently `[]`.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import {
  ageInYears,
  BREACH_LADDER_HOURS,
  breachLadderRung,
  DATA_REQUEST_DUE_DAYS,
  earliestErasableDate,
  ENCRYPTED_FIELD_PREFIX,
  isEncryptedFieldValue,
  isMinor,
  isPastRetentionWindow,
  PURPOSE_CODES,
  requestDueAt,
  type PurposeCode,
} from '@kaizen/shared';
import { prisma, unscopedPrisma, num } from '../../platform/db.js';
import { config } from '../../platform/config.js';
import { currentAuth, type AuthContext } from '../../platform/context.js';
import { emit } from '../../platform/eventBus.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { ApiError } from '../../platform/errors.js';
import { auditWrite, auditExport, auditBulkOperation, registerGovernedEntities } from '../../platform/audit.js';
import { assertCan, FIELD_PURPOSES } from '../../platform/permissions.js';
import { raiseException } from '../../platform/exceptions.js';
import { normaliseEmail, normalisePhone } from '../identity.js';
import { registerHook } from '../../platform/hooks.js';

registerGovernedEntities('cmp_privacy', [
  'privacy_notice',
  'consent',
  'data_principal_request',
  'data_breach',
]);

// ---------------------------------------------------------------------------
// Privacy notice
// ---------------------------------------------------------------------------

registerGovernedEntities('cmp_privacy', ['affiliation']);

export interface NoticePurpose {
  code: string;
  label: string;
  lawfulBasis: 'consent' | 'legitimate_use' | 'legal_obligation';
  dataCategories: string[];
  retention: string;
}

export async function getCurrentNotice() {
  const auth = currentAuth();
  const notice = await prisma.privacyNotice.findFirst({
    where: { tenantId: auth.tenantId, status: 'current' },
    orderBy: { version: 'desc' },
  });
  if (!notice) throw ApiError.notFound('Privacy notice');
  return notice;
}

/**
 * Publishes a new notice version. The one it replaces is superseded, never
 * edited — the same finality a filed GstFiling has.
 */
export async function publishNotice(input: { effectiveFrom: Date; body: string; purposes: NoticePurpose[] }) {
  const auth = currentAuth();
  await assertCan({ resource: 'privacy_notices', verb: 'create' });

  if (!input.body.trim()) throw ApiError.badRequest('A notice with no body tells nobody anything.');
  if (!input.purposes.length) {
    throw ApiError.badRequest('A notice naming no purposes cannot be the basis X-Purpose is checked against.');
  }

  const previous = await prisma.privacyNotice.findFirst({
    where: { tenantId: auth.tenantId, status: 'current' },
    orderBy: { version: 'desc' },
  });
  const version = (previous?.version ?? 0) + 1;

  const notice = await prisma.privacyNotice.create({
    data: {
      tenantId: auth.tenantId,
      version,
      effectiveFrom: input.effectiveFrom,
      body: input.body,
      purposes: input.purposes as never,
      status: 'current',
      publishedById: auth.partyId,
    },
  });

  if (previous) {
    await prisma.privacyNotice.update({ where: { id: previous.id }, data: { status: 'superseded', supersededById: notice.id } });
  }

  await auditWrite({ action: 'create', subjectType: 'privacy_notice', subjectId: notice.id, after: { version, effectiveFrom: input.effectiveFrom } });
  await emit({
    name: 'kz.cmp.privacy_notice.published',
    subject: { entityType: 'privacy_notice', entityId: notice.id, recordCode: `NOTICE-v${version}` },
    newState: { version, purposeCount: input.purposes.length },
    impact: { domains: ['cmp'] },
  });
  noticePurposeCache.delete(auth.tenantId);

  return notice;
}

export async function acknowledgeNotice(input: { personId?: string; channel: string }) {
  const auth = currentAuth();
  const personId = input.personId ?? auth.partyId;
  if (!personId) throw ApiError.badRequest('No person to acknowledge the notice for.');
  if (personId !== auth.partyId) {
    // Acting for somebody else — HR capturing a paper acknowledgement.
    await assertCan({ resource: 'consents', verb: 'edit' });
  }

  const notice = await getCurrentNotice();
  const ack = await prisma.noticeAcknowledgement.create({
    data: { tenantId: auth.tenantId, personId, noticeVersion: notice.version, channel: input.channel },
  });
  await auditWrite({
    action: 'create',
    subjectType: 'privacy_notice',
    subjectId: notice.id,
    after: { acknowledgedBy: personId, version: notice.version },
  });
  return ack;
}

/**
 * The purpose codes the current notice covers, cached briefly — this runs on
 * every request via `contextMiddleware`, so a DB round trip per request would
 * be the wrong trade for a value that changes maybe once a year.
 */
const noticePurposeCache = new Map<string, { at: number; codes: Set<string> }>();
const NOTICE_CACHE_TTL_MS = 30_000;

export async function currentNoticePurposeCodes(tenantId: string): Promise<Set<string>> {
  const cached = noticePurposeCache.get(tenantId);
  if (cached && Date.now() - cached.at < NOTICE_CACHE_TTL_MS) return cached.codes;

  const notice = await unscopedPrisma.privacyNotice.findFirst({
    where: { tenantId, status: 'current' },
    orderBy: { version: 'desc' },
  });
  const purposes = (notice?.purposes as NoticePurpose[] | undefined) ?? [];
  const codes = new Set(purposes.map((p) => p.code));
  // Even with no notice published yet, the platform's own fixed purpose list
  // is a safe fallback — it is what the seed publishes as the first notice.
  if (codes.size === 0) for (const c of PURPOSE_CODES) codes.add(c);
  noticePurposeCache.set(tenantId, { at: Date.now(), codes });
  return codes;
}

/** Called by `contextMiddleware`. `'operational'` when the header is absent or
 * names a purpose the notice does not cover — never a purpose invented by the
 * client. */
export async function resolvePurpose(tenantId: string, headerValue: string | undefined | null): Promise<string> {
  if (!headerValue) return 'operational';
  const codes = await currentNoticePurposeCodes(tenantId);
  return codes.has(headerValue) ? headerValue : 'operational';
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

export async function grantConsent(input: {
  personId: string;
  purposeCode: string;
  channel: string;
  evidence?: Record<string, unknown>;
  guardianOfPersonId?: string | null;
  expiresAt?: Date | null;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'consents', verb: 'create', record: { ownerPartyId: input.personId } });

  const codes = await currentNoticePurposeCodes(auth.tenantId);
  if (!codes.has(input.purposeCode)) {
    throw ApiError.badRequest(
      `'${input.purposeCode}' is not a purpose the current privacy notice names. Consent can only be recorded against a purpose the data principal was actually told about.`,
    );
  }

  const consent = await prisma.consent.create({
    data: {
      tenantId: auth.tenantId,
      personId: input.personId,
      purposeCode: input.purposeCode,
      noticeVersion: (await getCurrentNotice()).version,
      status: 'granted',
      grantedAt: new Date(),
      channel: input.channel,
      evidence: (input.evidence ?? {}) as never,
      guardianOfPersonId: input.guardianOfPersonId ?? null,
      expiresAt: input.expiresAt ?? null,
    },
  });

  await prisma.consentLedger.create({
    data: {
      tenantId: auth.tenantId,
      dataPrincipalId: input.personId,
      consentId: consent.id,
      purpose: input.purposeCode,
      noticeVersion: consent.noticeVersion,
      channel: input.channel,
      event: 'granted',
      givenAt: consent.grantedAt,
      evidence: (input.evidence ?? {}) as never,
    },
  });
  await auditWrite({ action: 'create', subjectType: 'consent_ledger', subjectId: consent.id, after: { event: 'granted', purpose: input.purposeCode } });
  await auditWrite({ action: 'create', subjectType: 'consent', subjectId: consent.id, after: { purposeCode: input.purposeCode, status: 'granted' } });
  await emit({
    name: 'kz.cmp.consent.granted',
    subject: { entityType: 'consent', entityId: consent.id },
    related: [{ relation: 'consent_of', entityType: 'person', entityId: input.personId }],
    newState: { purposeCode: input.purposeCode, guardian: Boolean(input.guardianOfPersonId) },
    owner: { partyId: input.personId },
    impact: { domains: ['cmp'] },
  });

  return consent;
}

export async function withdrawConsent(id: string, reason?: string) {
  const auth = currentAuth();
  const existing = await prisma.consent.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!existing) throw ApiError.notFound('Consent');
  await assertCan({ resource: 'consents', verb: 'edit', record: { ownerPartyId: existing.personId } });

  if (existing.status === 'withdrawn') return existing;

  const updated = await prisma.consent.update({
    where: { id },
    data: { status: 'withdrawn', withdrawnAt: new Date() },
  });

  await prisma.consentLedger.create({
    data: {
      tenantId: auth.tenantId,
      dataPrincipalId: existing.personId,
      consentId: existing.id,
      purpose: existing.purposeCode,
      noticeVersion: existing.noticeVersion,
      channel: existing.channel,
      event: 'withdrawn',
      withdrawnAt: updated.withdrawnAt,
      evidence: { reason: reason ?? null } as never,
    },
  });
  await auditWrite({ action: 'create', subjectType: 'consent_ledger', subjectId: existing.id, after: { event: 'withdrawn', purpose: existing.purposeCode } });
  await auditWrite({
    action: 'update',
    subjectType: 'consent',
    subjectId: id,
    before: { status: existing.status },
    after: { status: 'withdrawn', reason: reason ?? null },
  });
  await emit({
    name: 'kz.cmp.consent.withdrawn',
    subject: { entityType: 'consent', entityId: id },
    related: [{ relation: 'consent_of', entityType: 'person', entityId: existing.personId }],
    newState: { purposeCode: existing.purposeCode },
    owner: { partyId: existing.personId },
    impact: { domains: ['cmp'] },
  });

  return updated;
}

export async function listConsentsForPerson(personId: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'consents', verb: 'view', record: { ownerPartyId: personId } });
  const rows = await prisma.consent.findMany({ where: { tenantId: auth.tenantId, personId }, orderBy: { createdAt: 'desc' } });
  // Consent.personId carries no Prisma relation (guardianOfPersonId can name
  // a different person entirely, so the column is deliberately untyped as a
  // foreign key) — one batched lookup, not one query per row.
  const person = await prisma.person.findFirst({ where: { id: personId, tenantId: auth.tenantId }, select: { fullName: true } });
  return rows.map((r) => ({ ...r, personFullName: person?.fullName ?? null }));
}

/**
 * The rows that populate `ctx.auth.consentCodes`. Called from
 * `contextMiddleware` before `AuthContext` fully exists, so it takes the
 * tenant and person explicitly rather than reading `currentAuth()`.
 */
export async function grantedConsentCodes(tenantId: string, personId: string): Promise<string[]> {
  const now = new Date();
  const rows = await unscopedPrisma.consent.findMany({
    where: {
      tenantId,
      personId,
      status: 'granted',
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { purposeCode: true },
  });
  return [...new Set(rows.map((r) => r.purposeCode))];
}

// ---------------------------------------------------------------------------
// Minor / guardian consent gate — called from students.ts
// ---------------------------------------------------------------------------

export interface MinorGateInput {
  personId: string;
  dateOfBirth: Date | null;
  guardianName?: string | null;
  guardianPhone?: string | null;
  /**
   * The enrolling user's explicit attestation that the learner is 18 or over.
   * Consulted only when no date of birth is on file. Without a date the rule
   * is held, not waived: an unknown age is not an adult age, so the guardian
   * requirement stands unless somebody says, on the record, that they are an
   * adult. A measured age always wins, so an attestation can never release a
   * measured minor. FX-64.
   */
  adultAttested?: boolean;
}

/**
 * A date of birth as typed on a form. A date with no time is read as the IST
 * day it names: `new Date('2008-05-10')` is UTC midnight, which is 05:30 IST on
 * the same day. Refuses a value that does not parse or lies in the future. FX-64.
 */
export function parseStatedDateOfBirth(value: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw ApiError.badRequest('The date of birth is not a valid date.');
  if (d.getTime() > Date.now()) throw ApiError.badRequest('The date of birth is in the future.');
  return d;
}

/**
 * Whether the minor rule applies, and if it does, refuses unless a guardian
 * name and phone are given. Pure, so a caller can refuse before anything is
 * written; the consent row is written only by `requireGuardianConsentForMinor`.
 * Returns true when the rule applies.
 */
export function assertMinorHasGuardian(input: Omit<MinorGateInput, 'personId'>): boolean {
  const measured = isMinor(input.dateOfBirth);
  const applies = measured === true || (measured === null && input.adultAttested !== true);
  if (!applies) return false;

  if (!input.guardianName?.trim() || !input.guardianPhone?.trim()) {
    const basis =
      measured === true
        ? `This student is under 18 (age ${ageInYears(input.dateOfBirth)})`
        : 'No date of birth is on file and no adult has been attested, so the minor rule applies. Give a date of birth, or a guardian name and phone, or confirm they are 18 or over';
    // 422, not 400: the request is well formed and the learner's record is what is
    // missing, so the caller can supply it and retry. FX-64.
    throw ApiError.unprocessable(
      `${basis}. A minor cannot be enrolled without a named guardian and a recorded guardian consent — give a guardian name and phone.`,
      { reason: 'MINOR_GUARDIAN_CONSENT_REQUIRED' },
    );
  }
  return true;
}

/**
 * CMP-DPD-003. If the minor rule applies, refuses unless a guardian name and
 * phone are given, and returns the id of the Consent row recorded for them so
 * the caller can stamp `guardianConsentId`. Returns `null` when the rule does
 * not apply — nothing to gate.
 */
export async function requireGuardianConsentForMinor(input: MinorGateInput): Promise<string | null> {
  if (!assertMinorHasGuardian(input)) return null;

  const auth = currentAuth();
  const consent = await prisma.consent.create({
    data: {
      tenantId: auth.tenantId,
      personId: input.personId,
      purposeCode: 'education_delivery',
      noticeVersion: (await getCurrentNotice()).version,
      status: 'granted',
      grantedAt: new Date(),
      channel: 'guardian_intake',
      evidence: { guardianName: encryptField(input.guardianName!.trim()), guardianPhone: encryptField(input.guardianPhone!.trim()) } as never,
      guardianOfPersonId: input.personId,
    },
  });

  await prisma.consentLedger.create({
    data: {
      tenantId: auth.tenantId,
      dataPrincipalId: input.personId,
      consentId: consent.id,
      purpose: 'education_delivery',
      noticeVersion: consent.noticeVersion,
      channel: 'guardian_intake',
      event: 'granted',
      givenAt: consent.grantedAt,
      evidence: { guardianName: encryptField(input.guardianName!.trim()), guardianPhone: encryptField(input.guardianPhone!.trim()) } as never,
    },
  });
  await auditWrite({ action: 'create', subjectType: 'consent_ledger', subjectId: consent.id, after: { event: 'granted', purpose: 'education_delivery' } });
  await auditWrite({
    action: 'create',
    subjectType: 'consent',
    subjectId: consent.id,
    after: { purposeCode: 'education_delivery', guardianOfPersonId: input.personId },
  });

  return consent.id;
}

/** Monthly: students who turned 18 since consent was captured on a guardian
 * basis — the basis for processing their data has changed and somebody should
 * look. Not a violation, a fact worth flagging. */
export async function flagMajorityTransitions(): Promise<number> {
  const auth = currentAuth();
  const students = await prisma.studentProfile.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, guardianConsentId: { not: null } },
    include: { person: { select: { id: true, fullName: true, dateOfBirth: true, recordCode: true } } },
  });

  let raised = 0;
  for (const s of students) {
    if (isMinor(s.person.dateOfBirth) === false) {
      const res = await raiseException({
        code: 'CMP_DPD_MAJORITY',
        label: 'Student turned 18 — consent basis changes',
        severity: 'S1_ATTENTION',
        subjectType: 'student_profile',
        subjectId: s.id,
        subjectLabel: s.person.fullName,
        domain: 'cmp',
        detail: `${s.person.fullName} (${s.person.recordCode}) is now an adult; their record was enrolled on guardian consent. Fresh consent in their own name is due.`,
        ownerPartyId: await privacyOwnerPartyId(auth.tenantId),
        triggerFingerprint: 'majority_transition',
        ladderRung: 1,
      });
      if (res) raised += 1;
    }
  }
  return raised;
}

// ---------------------------------------------------------------------------
// Data-principal requests
// ---------------------------------------------------------------------------

export async function raiseDataRequest(input: { personId: string; kind: string; note?: string | null }) {
  const auth = currentAuth();
  await assertCan({ resource: 'data_requests', verb: 'create', record: { ownerPartyId: input.personId } });

  const receivedAt = new Date();
  const recordCode = await nextRecordCode('DPR');
  const request = await prisma.dataPrincipalRequest.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      personId: input.personId,
      kind: input.kind,
      status: 'received',
      receivedAt,
      dueAt: requestDueAt(receivedAt, DATA_REQUEST_DUE_DAYS),
      requestDetail: input.note ? ({ note: input.note } as never) : undefined,
      raisedById: auth.partyId,
    },
  });

  await auditWrite({ action: 'create', subjectType: 'data_principal_request', subjectId: request.id, after: { kind: input.kind, personId: input.personId } });
  await emit({
    name: 'kz.cmp.data_request.raised',
    subject: { entityType: 'data_principal_request', entityId: request.id, recordCode },
    newState: { kind: input.kind, dueAt: request.dueAt },
    owner: { partyId: input.personId },
    impact: { domains: ['cmp'] },
  });

  return request;
}

export async function listDataRequests(filter: { status?: string; personId?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'data_requests', verb: 'view' });
  const rows = await prisma.dataPrincipalRequest.findMany({
    where: {
      tenantId: auth.tenantId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.personId ? { personId: filter.personId } : {}),
    },
    orderBy: { receivedAt: 'desc' },
    take: 200,
  });
  // DataPrincipalRequest.personId carries no Prisma relation, so this is one
  // batched lookup across every row on the page rather than one per row —
  // the unfiltered listing mixes requests from many people, and without a
  // name a reviewer sees nothing but a cuid per row.
  const people = await prisma.person.findMany({
    where: { tenantId: auth.tenantId, id: { in: [...new Set(rows.map((r) => r.personId))] } },
    select: { id: true, fullName: true },
  });
  const byId = new Map(people.map((p) => [p.id, p.fullName]));
  return rows.map((r) => ({ ...r, personFullName: byId.get(r.personId) ?? null }));
}

async function getDataRequest(id: string) {
  const auth = currentAuth();
  const request = await prisma.dataPrincipalRequest.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!request) throw ApiError.notFound('Data principal request');
  return request;
}

/**
 * The regulated fields a person's data touches — read with `unscopedPrisma`
 * under the (already-verified) tenant, because a data principal is entitled to
 * see what is held about them even where the ordinary read path would redact
 * it for a colleague.
 */
async function assembleAccessExport(tenantId: string, personId: string) {
  const [person, affiliations, employments, studentProfile] = await Promise.all([
    unscopedPrisma.person.findFirst({ where: { id: personId, tenantId } }),
    unscopedPrisma.affiliation.findMany({ where: { partyId: personId, tenantId } }),
    unscopedPrisma.employmentRelationship.findMany({ where: { personId, tenantId } }),
    unscopedPrisma.studentProfile.findFirst({ where: { personId, tenantId } }),
  ]);

  const employmentsDecrypted = employments.map((e) => ({
    ...e,
    panNumber: readRegulated(e.panNumber),
    aadhaarReference: readRegulated(e.aadhaarReference),
    bankAccountNumber: readRegulated(e.bankAccountNumber),
    bankAccountName: readRegulated(e.bankAccountName),
    bankIfsc: readRegulated(e.bankIfsc),
  }));

  return {
    person,
    affiliations,
    employments: employmentsDecrypted,
    // The export is for the data principal, so the guardian values come out in
    // the clear here, as the employment values above do.
    studentProfile: studentProfile
      ? {
          ...studentProfile,
          guardianName: readRegulated(studentProfile.guardianName),
          guardianPhone: readRegulated(studentProfile.guardianPhone),
        }
      : null,
    dataMap: [
      { source: 'person', fields: ['fullName', 'email', 'phone', 'dateOfBirth'].map((field) => ({ field, purpose: FIELD_PURPOSES[field] })) },
      { source: 'affiliations', purpose: 'employment|education_delivery', fields: ['roleSlug', 'status', 'effectiveFrom', 'effectiveTo'] },
      { source: 'employments', purpose: 'employment|statutory_filing', fields: ['status', 'panNumber', 'aadhaarReference', 'bankAccountNumber', 'bankAccountName', 'bankIfsc'] },
      { source: 'studentProfile', purpose: 'education_delivery', fields: ['guardianName', 'guardianPhone', 'guardianConsentId'] },
    ],
    exportedAt: new Date().toISOString(),
  };
}

/**
 * Everything an erasure request can be blocked by, named rather than merely
 * refused. CMP-DPD-002.
 */
export interface ErasureBlocker {
  retentionClass: string;
  /** Set when the statutory floor is measured and still running. */
  earliestErasable: Date | null;
  /** The floor has no schedule to measure it against. */
  unmeasured: boolean;
  /** An affiliation is still running, so there is no end to measure from. */
  active: boolean;
}

/**
 * Everything an erasure request can be blocked by, named rather than merely
 * refused. CMP-DPD-002.
 *
 * An affiliation that has not ended blocks erasure whether or not it carries
 * the statutory floor: a live relationship has no end date to measure the
 * window from, so a floor anchored on its start would clear it early.
 * Suspended counts as live. FX-62.
 */
async function erasureBlockers(tenantId: string, personId: string): Promise<ErasureBlocker[]> {
  const affiliations = await unscopedPrisma.affiliation.findMany({ where: { tenantId, partyId: personId } });
  if (!affiliations.length) return [];

  const schedules = await unscopedPrisma.retentionSchedule.findMany({ where: { tenantId }, orderBy: { effectiveFrom: 'desc' } });
  const blockers: ErasureBlocker[] = [];
  const now = new Date();

  for (const aff of affiliations) {
    const retentionClass = aff.affiliationType === 'student' ? 'student_record' : 'employee_record';
    const active = aff.status !== 'ended';
    if (!aff.statutoryRetentionFloor && !active) continue;

    let earliestErasable: Date | null = null;
    let unmeasured = false;
    if (aff.statutoryRetentionFloor) {
      const schedule = schedules.find((s) => s.retentionClass === retentionClass && s.effectiveFrom <= now);
      // No schedule means the window cannot be measured. That is a block, not a
      // clearance: erasing now would destroy records the floor still holds.
      // FX-62.
      if (!schedule) {
        unmeasured = true;
      } else {
        const anchor = aff.effectiveTo ?? aff.effectiveFrom;
        const window = { retentionClass, years: schedule.years, anchor };
        if (!isPastRetentionWindow(window, now)) earliestErasable = earliestErasableDate(window);
      }
    }
    if (active || unmeasured || earliestErasable) {
      blockers.push({ retentionClass, earliestErasable, unmeasured, active });
    }
  }
  return blockers;
}

/**
 * The Person fields a data principal may correct. Everything else on Person is
 * platform state (dedupe, merge pointer, soft delete, codes, classifications).
 * Add a field here only when a principal can legitimately be the authority on
 * it; the normalised twins are derived below, never accepted from the caller.
 */
const CORRECTABLE_PERSON_FIELDS = [
  'fullName',
  'primaryPhone',
  'primaryEmail',
  'additionalPhones',
  'additionalEmails',
  'dateOfBirth',
  'bloodGroup',
] as const;
type CorrectablePersonField = (typeof CORRECTABLE_PERSON_FIELDS)[number];

/**
 * Builds the write for an allowlisted correction. The normalised columns are
 * what identity matching reads (identity.ts), so a corrected phone or email
 * must move them too or the person is unfindable by the number they gave us.
 */
function correctionData(correction: Partial<Record<CorrectablePersonField, unknown>>): Record<string, unknown> {
  const data: Record<string, unknown> = { ...correction };
  if (typeof correction.primaryPhone === 'string' || correction.primaryPhone === null) {
    data.primaryPhoneNormalised = normalisePhone(correction.primaryPhone as string | null);
  }
  if (typeof correction.primaryEmail === 'string' || correction.primaryEmail === null) {
    data.primaryEmailNormalised = normaliseEmail(correction.primaryEmail as string | null);
  }
  if (Array.isArray(correction.additionalPhones)) {
    data.additionalPhonesNormalised = (correction.additionalPhones as string[]).map((p) => normalisePhone(p)).filter((p): p is string => !!p);
  }
  if (Array.isArray(correction.additionalEmails)) {
    data.additionalEmailsNormalised = (correction.additionalEmails as string[]).map((e) => normaliseEmail(e)).filter((e): e is string => !!e);
  }
  return data;
}

/**
 * A contact another active person already holds cannot be given to this one.
 * Identity matching reads the normalised key, so two active people on one key
 * makes either unfindable by it, and the next enrolment on that number is
 * refused as ambiguous. Holders are matched on the normalised twin, so the
 * same address in another case still collides. FX-63.
 *
 * The message names no other person: the requester is an operator, not the
 * principal, and a refusal should not tell them whose record it is.
 */
async function assertContactsFree(tenantId: string, personId: string, correction: Record<string, unknown>): Promise<void> {
  const emails = [
    ...(typeof correction.primaryEmail === 'string' ? [correction.primaryEmail] : []),
    ...(Array.isArray(correction.additionalEmails) ? (correction.additionalEmails as string[]) : []),
  ]
    .map((e) => normaliseEmail(e))
    .filter((k): k is string => !!k);
  const phones = [
    ...(typeof correction.primaryPhone === 'string' ? [correction.primaryPhone] : []),
    ...(Array.isArray(correction.additionalPhones) ? (correction.additionalPhones as string[]) : []),
  ]
    .map((p) => normalisePhone(p))
    .filter((k): k is string => !!k);

  const base = { tenantId, id: { not: personId }, deletedAt: null, dedupeStatus: { not: 'merged' } };
  for (const key of emails) {
    const holder = await unscopedPrisma.person.findFirst({
      where: { ...base, OR: [{ primaryEmailNormalised: key }, { additionalEmailsNormalised: { has: key } }] },
      select: { id: true },
    });
    if (holder) throw ApiError.conflict('That email address is already held by another active person on file, so it cannot be given to this one.');
  }
  for (const key of phones) {
    const holder = await unscopedPrisma.person.findFirst({
      where: { ...base, OR: [{ primaryPhoneNormalised: key }, { additionalPhonesNormalised: { has: key } }] },
      select: { id: true },
    });
    if (holder) throw ApiError.conflict('That phone number is already held by another active person on file, so it cannot be given to this one.');
  }
}

/**
 * A corrected date of birth. It can be changed but not removed: with no date
 * on file the minor rule applies, so clearing it would silently change what
 * the enrolments rest on. FX-63.
 */
function correctedDateOfBirth(value: unknown): Date {
  if (value === null || value === undefined || value === '') {
    throw ApiError.badRequest('A date of birth can be corrected but not removed. With none on file the minor rule applies to the enrolments.');
  }
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) throw ApiError.badRequest('The corrected date of birth is not a valid date.');
  if (d.getTime() > Date.now()) throw ApiError.badRequest('The corrected date of birth is in the future.');
  return d;
}

/**
 * Runs the minor gate for each of the person's enrolments against the
 * corrected date of birth, before anything is written. A learner the
 * correction makes a minor must have a guardian name and phone on each
 * enrolment, or the correction is refused. FX-63.
 */
async function reRunMinorGateForEnrolments(tenantId: string, personId: string, dateOfBirth: Date) {
  const enrollments = await unscopedPrisma.enrollment.findMany({ where: { tenantId, personId } });
  for (const e of enrollments) {
    assertMinorHasGuardian({
      dateOfBirth,
      guardianName: readRegulated(e.guardianName),
      guardianPhone: readRegulated(e.guardianPhone),
    });
  }
  return enrollments;
}

export async function fulfilDataRequest(id: string, input: { correction?: Record<string, unknown> } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'data_requests', verb: 'edit' });
  const request = await getDataRequest(id);
  if (request.status === 'fulfilled') return request;

  if (request.kind === 'access' || request.kind === 'nomination') {
    const bundle = await assembleAccessExport(auth.tenantId, request.personId);
    await auditExport('person_data_export', request.personId, 1);
    const updated = await prisma.dataPrincipalRequest.update({
      where: { id },
      data: { status: 'fulfilled', fulfilledAt: new Date(), response: bundle as never },
    });
    await auditWrite({ action: 'update', subjectType: 'data_principal_request', subjectId: id, before: { status: request.status }, after: { status: 'fulfilled' } });
    return updated;
  }

  if (request.kind === 'correction') {
    if (!input.correction || Object.keys(input.correction).length === 0) {
      throw ApiError.badRequest('A correction request is fulfilled by giving the corrected fields.');
    }
    // FX-63. A principal corrects the personal values they are the subject
    // of. Dedupe state, the merge pointer, the soft delete and the record code
    // are the platform's to set, so they are refused by name rather than
    // dropped silently: a silent drop would look like a correction that
    // succeeded.
    const disallowed = Object.keys(input.correction).filter((k) => !CORRECTABLE_PERSON_FIELDS.includes(k as CorrectablePersonField));
    if (disallowed.length) {
      throw ApiError.badRequest(`These fields cannot be corrected by a data-principal request: ${disallowed.join(', ')}.`);
    }
    // Every refusal below happens before the first write, so a refused
    // correction leaves the person, the enrolments and the request as they were.
    await assertContactsFree(auth.tenantId, request.personId, input.correction);
    let newDob: Date | undefined;
    if ('dateOfBirth' in input.correction) newDob = correctedDateOfBirth(input.correction.dateOfBirth);
    const enrollments = newDob ? await reRunMinorGateForEnrolments(auth.tenantId, request.personId, newDob) : [];

    // A learner the correction makes a minor needs the guardian consent their
    // enrolment rests on. The guardian contact is already on the enrolment (the
    // gate above checked), so the consent is recorded from it.
    const minorNow = newDob ? isMinor(newDob) === true : false;
    let consentId: string | null = null;
    if (newDob && minorNow && enrollments.some((e) => !e.guardianConsentId)) {
      const source = enrollments[0];
      consentId = await requireGuardianConsentForMinor({
        personId: request.personId,
        dateOfBirth: newDob,
        guardianName: readRegulated(source.guardianName),
        guardianPhone: readRegulated(source.guardianPhone),
      });
    }

    const before = await unscopedPrisma.person.findFirst({ where: { id: request.personId, tenantId: auth.tenantId } });
    const personData = correctionData(input.correction as Partial<Record<CorrectablePersonField, unknown>>);
    if (newDob) personData.dateOfBirth = newDob;
    const after = await prisma.person.update({
      where: { id: request.personId },
      data: personData as never,
    });
    await auditWrite({
      action: 'update',
      subjectType: 'person',
      subjectId: request.personId,
      before: before as never,
      after: after as never,
    });

    for (const e of enrollments) {
      const data: { isMinor?: boolean; guardianConsentId?: string } = {};
      if (e.isMinor !== minorNow) data.isMinor = minorNow;
      if (minorNow && !e.guardianConsentId && consentId) data.guardianConsentId = consentId;
      if (Object.keys(data).length === 0) continue;
      await prisma.enrollment.update({ where: { id: e.id }, data });
      await auditWrite({
        action: 'update',
        subjectType: 'enrollment',
        subjectId: e.id,
        before: { isMinor: e.isMinor, guardianConsentId: e.guardianConsentId },
        after: { isMinor: minorNow, guardianConsentId: data.guardianConsentId ?? e.guardianConsentId },
      });
    }

    const updated = await prisma.dataPrincipalRequest.update({
      where: { id },
      data: { status: 'fulfilled', fulfilledAt: new Date(), response: { corrected: input.correction } as never },
    });
    await auditWrite({ action: 'update', subjectType: 'data_principal_request', subjectId: id, before: { status: request.status }, after: { status: 'fulfilled' } });
    return updated;
  }

  // erasure
  const blockers = await erasureBlockers(auth.tenantId, request.personId);
  if (blockers.length) {
    const active = [...new Set(blockers.filter((b) => b.active).map((b) => b.retentionClass))];
    const dated = blockers.filter((b): b is ErasureBlocker & { earliestErasable: Date } => b.earliestErasable !== null);
    const unmeasured = [...new Set(blockers.filter((b) => b.unmeasured).map((b) => b.retentionClass))];
    const parts: string[] = [];
    if (active.length) {
      parts.push(`An affiliation is still active (${active.join(', ')}), so erasure cannot proceed until it has ended.`);
    }
    if (dated.length) {
      const earliest = dated.reduce((min, b) => (b.earliestErasable < min ? b.earliestErasable : min), dated[0].earliestErasable);
      parts.push(`Blocked by the statutory retention floor on ${[...new Set(dated.map((b) => b.retentionClass))].join(', ')}. Not erasable before ${earliest.toISOString().slice(0, 10)}.`);
    }
    if (unmeasured.length) {
      parts.push(`No retention schedule is recorded for ${unmeasured.join(', ')}, so the floor cannot be measured and erasure cannot proceed.`);
    }
    const refusalReason = parts.join(' ');
    const updated = await prisma.dataPrincipalRequest.update({
      where: { id },
      data: { status: 'refused', refusalReason },
    });
    await auditWrite({ action: 'update', subjectType: 'data_principal_request', subjectId: id, before: { status: request.status }, after: { status: 'refused', refusalReason } });
    return updated;
  }

  const token = `erased:${request.personId}`;
  // One transaction for the scrub, so the Person is never blanked while its
  // guardian contact survives on an enrolment or a consent. FX-62. Nested
  // writes bypass the tenant extension (CLAUDE.md rule 6), so each dependent
  // write names the tenant itself. Rows are blanked, never deleted: the
  // enrolment and funding history is not personal data and must survive.
  const dependents = await prisma.$transaction(async (tx) => {
    await tx.person.update({
      where: { id: request.personId },
      data: {
        fullName: token,
        primaryPhone: null,
        primaryEmail: null,
        primaryPhoneNormalised: null,
        primaryEmailNormalised: null,
        additionalPhones: [],
        additionalEmails: [],
        additionalPhonesNormalised: [],
        additionalEmailsNormalised: [],
        bloodGroup: null,
        dateOfBirth: null,
        notes: null,
        externalIds: [],
        deletedAt: new Date(),
      } as never,
    });
    // The StudentProfile row survives; its personal values are blanked.
    await tx.studentProfile.updateMany({
      where: { tenantId: auth.tenantId, personId: request.personId },
      data: { guardianName: null, guardianPhone: null, address: null },
    });
    const enrollmentIds = (
      await tx.enrollment.findMany({ where: { tenantId: auth.tenantId, personId: request.personId }, select: { id: true } })
    ).map((e) => e.id);
    await tx.enrollment.updateMany({
      where: { tenantId: auth.tenantId, id: { in: enrollmentIds } },
      data: { guardianName: null, guardianPhone: null, guardianEmail: null },
    });
    // A minor's guardian consent names the guardian in its evidence, and is
    // matched on either the minor (personId) or the guardian link.
    const consentIds = (
      await tx.consent.findMany({
        where: { tenantId: auth.tenantId, OR: [{ personId: request.personId }, { guardianOfPersonId: request.personId }] },
        select: { id: true },
      })
    ).map((c) => c.id);
    await tx.consent.updateMany({
      where: { tenantId: auth.tenantId, id: { in: consentIds } },
      data: { evidence: {} as never },
    });
    return { enrollmentIds, consentIds };
  });
  const updated = await prisma.dataPrincipalRequest.update({
    where: { id },
    data: { status: 'fulfilled', fulfilledAt: new Date(), response: { erased: true, token } as never },
  });
  // Audited per dependent row, without the values: the audit log is kept
  // longer than the record and must not become the place the value survives.
  for (const enrollmentId of dependents.enrollmentIds) {
    await auditWrite({ action: 'update', subjectType: 'enrollment', subjectId: enrollmentId, after: { guardianContactErased: true } });
  }
  for (const consentId of dependents.consentIds) {
    await auditWrite({ action: 'update', subjectType: 'consent', subjectId: consentId, after: { evidenceErased: true } });
  }
  await auditWrite({
    action: 'delete',
    subjectType: 'person',
    subjectId: request.personId,
    after: { erased: true, dependents: ['student_profile', 'enrollment', 'consent'] },
  });
  await auditWrite({ action: 'update', subjectType: 'data_principal_request', subjectId: id, before: { status: request.status }, after: { status: 'fulfilled' } });
  await emit({
    name: 'kz.cmp.data_request.fulfilled',
    subject: { entityType: 'data_principal_request', entityId: id, recordCode: request.recordCode },
    newState: { kind: request.kind, status: 'fulfilled' },
    impact: { domains: ['cmp'] },
  });

  return updated;
}

export async function refuseDataRequest(id: string, reason: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'data_requests', verb: 'edit' });
  const request = await getDataRequest(id);
  const updated = await prisma.dataPrincipalRequest.update({ where: { id }, data: { status: 'refused', refusalReason: reason } });
  await auditWrite({ action: 'update', subjectType: 'data_principal_request', subjectId: id, before: { status: request.status }, after: { status: 'refused', reason } });
  void auth;
  return updated;
}

/** Daily: requests past `dueAt` and not yet fulfilled or refused. */
export async function detectOverdueDataRequests(): Promise<number> {
  const auth = currentAuth();
  const overdue = await prisma.dataPrincipalRequest.findMany({
    where: { tenantId: auth.tenantId, status: { in: ['received', 'verifying'] }, dueAt: { lt: new Date() } },
  });
  let raised = 0;
  for (const r of overdue) {
    const res = await raiseException({
      code: 'CMP_DPD_REQUEST_OVERDUE',
      label: 'Data-principal request past its due date',
      severity: 'S2_WARNING',
      subjectType: 'data_principal_request',
      subjectId: r.id,
      subjectLabel: r.recordCode,
      domain: 'cmp',
      detail: `${r.kind} request ${r.recordCode} was due ${r.dueAt.toISOString().slice(0, 10)} and is still ${r.status}.`,
      ownerPartyId: await privacyOwnerPartyId(auth.tenantId),
      triggerFingerprint: 'request_overdue',
      ladderRung: 1,
    });
    if (res) raised += 1;
  }
  return overdue.length;
}

// ---------------------------------------------------------------------------
// Breach register — 72-hour ladder
// ---------------------------------------------------------------------------

export async function raiseBreach(input: {
  detectedAt: Date;
  description: string;
  categories?: string[];
  principalsAffected?: number;
  severity: string;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'breaches', verb: 'create' });

  const recordCode = await nextRecordCode('BRC');
  const breach = await prisma.dataBreach.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      detectedAt: input.detectedAt,
      description: input.description,
      categories: input.categories ?? [],
      principalsAffected: input.principalsAffected ?? 0,
      severity: input.severity,
      status: 'open',
      raisedById: auth.partyId,
    },
  });

  await auditWrite({ action: 'create', subjectType: 'data_breach', subjectId: breach.id, after: { detectedAt: input.detectedAt, severity: input.severity } });
  await emit({
    name: 'kz.cmp.breach.raised',
    subject: { entityType: 'data_breach', entityId: breach.id, recordCode },
    newState: { severity: input.severity, principalsAffected: breach.principalsAffected },
    impact: { domains: ['cmp'], severity: 'S4_CRITICAL' },
  });

  return breach;
}

const BREACH_TRANSITIONS: Record<string, string[]> = {
  open: ['contained', 'notified_board', 'closed'],
  contained: ['notified_board', 'closed'],
  notified_board: ['notified_principals', 'closed'],
  notified_principals: ['closed'],
  closed: [],
};

export async function transitionBreach(id: string, status: string, notes?: string | null) {
  const auth = currentAuth();
  await assertCan({ resource: 'breaches', verb: 'edit' });
  const breach = await prisma.dataBreach.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!breach) throw ApiError.notFound('Breach');

  if (!BREACH_TRANSITIONS[breach.status]?.includes(status)) {
    throw ApiError.unprocessable(`A breach at '${breach.status}' cannot move to '${status}'.`);
  }

  const now = new Date();
  const data: Record<string, unknown> = { status, notes: notes ?? breach.notes };
  if (status === 'contained') data.containedAt = now;
  if (status === 'notified_board') data.boardNotifiedAt = now;
  if (status === 'notified_principals') data.principalsNotifiedAt = now;
  if (status === 'closed') data.closedAt = now;

  const updated = await prisma.dataBreach.update({ where: { id }, data: data as never });
  await auditWrite({ action: 'update', subjectType: 'data_breach', subjectId: id, before: { status: breach.status }, after: { status } });
  await emit({
    name: 'kz.cmp.breach.transitioned',
    subject: { entityType: 'data_breach', entityId: id, recordCode: breach.recordCode },
    previousState: { status: breach.status },
    newState: { status },
    impact: { domains: ['cmp'], severity: status === 'closed' ? 'S1_ATTENTION' : 'S4_CRITICAL' },
  });

  return updated;
}

export async function listBreaches(filter: { status?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'breaches', verb: 'view' });
  return prisma.dataBreach.findMany({
    where: { tenantId: auth.tenantId, ...(filter.status ? { status: filter.status } : {}) },
    orderBy: { detectedAt: 'desc' },
    take: 200,
  });
}

/**
 * The 72-hour ladder. Fires once per rung (24/48/72h), idempotently, until
 * `boardNotifiedAt` is set — a breach that has already told the board stops
 * escalating regardless of how long ago it was detected.
 */
export async function runBreachLadder(): Promise<number> {
  const auth = currentAuth();
  const open = await prisma.dataBreach.findMany({
    where: { tenantId: auth.tenantId, boardNotifiedAt: null, status: { notIn: ['closed'] } },
  });

  let raised = 0;
  const now = Date.now();
  for (const breach of open) {
    const hoursElapsed = (now - breach.detectedAt.getTime()) / 3_600_000;
    const rung = breachLadderRung(hoursElapsed);
    if (rung === 0) continue;
    const res = await raiseException({
      code: 'CMP_DPD_BREACH_72H',
      label: `Breach notification window: ${BREACH_LADDER_HOURS[rung - 1]}h crossed`,
      severity: 'S4_CRITICAL',
      subjectType: 'data_breach',
      subjectId: breach.id,
      subjectLabel: breach.recordCode,
      domain: 'cmp',
      detail: `${breach.recordCode} was detected ${breach.detectedAt.toISOString()}. The DPDP Rules give 72 hours to notify the board/regulator; ${BREACH_LADDER_HOURS[rung - 1]} of them have passed with no board notification recorded.`,
      ownerPartyId: await privacyOwnerPartyId(auth.tenantId),
      triggerFingerprint: 'breach_72h_ladder',
      ladderRung: rung,
    });
    if (res) raised += 1;
  }
  return raised;
}

// ---------------------------------------------------------------------------
// Retention — reads EventRecord.retentionClass and RetentionSchedule, reports,
// never deletes.
// ---------------------------------------------------------------------------

export async function runRetentionReport(): Promise<{ generatedAt: Date; snapshot: unknown[] }> {
  const auth = currentAuth();
  const schedules = await prisma.retentionSchedule.findMany({ where: { tenantId: auth.tenantId }, orderBy: { effectiveFrom: 'desc' } });
  const now = new Date();
  const classes = [...new Set(schedules.map((s) => s.retentionClass))];

  const snapshot: Array<{ retentionClass: string; years: number; totalCount: number; pastWindowCount: number; cutoff: string }> = [];
  for (const retentionClass of classes) {
    const schedule = schedules.find((s) => s.retentionClass === retentionClass && s.effectiveFrom <= now);
    if (!schedule) continue;
    const cutoff = new Date(now);
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() - schedule.years);
    const [totalCount, pastWindowCount] =
      retentionClass === 'audit_record'
        ? await Promise.all([
            prisma.auditRecord.count({ where: { tenantId: auth.tenantId, retentionClass } }),
            prisma.auditRecord.count({ where: { tenantId: auth.tenantId, retentionClass, timestamp: { lt: cutoff } } }),
          ])
        : await Promise.all([
            prisma.eventRecord.count({ where: { tenantId: auth.tenantId, retentionClass } }),
            prisma.eventRecord.count({ where: { tenantId: auth.tenantId, retentionClass, occurredAt: { lt: cutoff } } }),
          ]);
    snapshot.push({ retentionClass, years: schedule.years, totalCount, pastWindowCount, cutoff: cutoff.toISOString() });
  }

  const report = await prisma.retentionReport.create({ data: { tenantId: auth.tenantId, generatedAt: now, snapshot: snapshot as never } });
  return { generatedAt: report.generatedAt, snapshot };
}

export async function getRetention() {
  const auth = currentAuth();
  await assertCan({ resource: 'data_requests', verb: 'view' });
  const [latest, schedule] = await Promise.all([
    prisma.retentionReport.findFirst({ where: { tenantId: auth.tenantId }, orderBy: { generatedAt: 'desc' } }),
    prisma.retentionSchedule.findMany({ where: { tenantId: auth.tenantId }, orderBy: [{ retentionClass: 'asc' }, { effectiveFrom: 'desc' }] }),
  ]);
  return { latest, schedule };
}

// ---------------------------------------------------------------------------
// Access revocation on offboarding, and the weekly stale-access sweep
// ---------------------------------------------------------------------------

registerHook('offboarding.completed', 'privacy.revoke_access', async (payload) => {
  const employmentRelationship = payload.employmentRelationship as { personId: string } | undefined;
  if (!employmentRelationship?.personId) return;
  const auth = currentAuth();

  const active = await prisma.affiliation.findMany({
    where: { tenantId: auth.tenantId, partyId: employmentRelationship.personId, status: 'active' },
  });
  for (const aff of active) {
    await prisma.affiliation.update({
      where: { id: aff.id },
      data: { status: 'ended', revokedAt: new Date(), revokedReason: 'offboarding' },
    });
    await auditWrite({
      action: 'update',
      subjectType: 'affiliation',
      subjectId: aff.id,
      before: { status: 'active' },
      after: { status: 'ended', revokedReason: 'offboarding' },
    });
  }
});

/** Weekly: an active affiliation whose employment is not Active is access that
 * outlived the reason it was granted. */
export async function runAccessReview(): Promise<number> {
  const auth = currentAuth();
  const affiliations = await prisma.affiliation.findMany({
    where: { tenantId: auth.tenantId, affiliationType: 'employee', status: 'active' },
    include: { party: { select: { fullName: true } } },
  });

  const personIds = affiliations.map((a) => a.partyId);
  const employments = personIds.length
    ? await prisma.employmentRelationship.findMany({ where: { tenantId: auth.tenantId, personId: { in: personIds } } })
    : [];
  const statusByPerson = new Map<string, string>();
  for (const e of employments) {
    // Most recent employment row per person wins.
    const existing = statusByPerson.get(e.personId);
    if (!existing) statusByPerson.set(e.personId, e.status);
  }

  const findings: Array<{ partyId: string; fullName: string; affiliationId: string; employmentStatus: string | null }> = [];
  for (const aff of affiliations) {
    const status = statusByPerson.get(aff.partyId) ?? null;
    if (status !== 'Active') {
      findings.push({ partyId: aff.partyId, fullName: aff.party.fullName, affiliationId: aff.id, employmentStatus: status });
    }
  }

  await prisma.accessReview.create({
    data: { tenantId: auth.tenantId, generatedAt: new Date(), findings: findings as never, staleCount: findings.length },
  });

  const ownerPartyId = await privacyOwnerPartyId(auth.tenantId);
  for (const f of findings) {
    await raiseException({
      code: 'CMP_DPD_STALE_ACCESS',
      label: 'Active access with no matching active employment',
      severity: 'S2_WARNING',
      subjectType: 'affiliation',
      subjectId: f.affiliationId,
      subjectLabel: f.fullName,
      domain: 'cmp',
      detail: `${f.fullName} holds an active affiliation while their employment status is ${f.employmentStatus ?? 'unknown'}.`,
      ownerPartyId,
      triggerFingerprint: 'stale_access',
      ladderRung: 1,
    });
  }

  return findings.length;
}

async function privacyOwnerPartyId(tenantId: string): Promise<string | null> {
  const holder = await unscopedPrisma.affiliation.findFirst({
    where: { tenantId, roleSlug: 'hr_ops_manager', status: 'active' },
    select: { partyId: true },
  });
  return holder?.partyId ?? null;
}

// ---------------------------------------------------------------------------
// Field-level encryption at rest (CMP-DPD-004)
//
// PAN, Aadhaar and bank values are written by HR's employment.ts, which this
// workstream does not own — the write path there is structural exclusion from
// responses, not encryption at rest. `encryptField`/`decryptField` are offered
// here for any write path to call; `readRegulated` is the read-side helper.
// Until employment.ts's own write path calls `encryptField` (outside this
// workstream's files), `backfillEncryptAtRest` closes the gap for what is
// already on disk. See docs/compliance/privacy.md for exactly which write
// paths still write plaintext.
// ---------------------------------------------------------------------------

const DEV_ENCRYPTION_KEY = 'kaizen-dev-field-encryption-key-DO-NOT-USE-IN-PRODUCTION';
let warnedAboutDevKey = false;

function encryptionKey(): Buffer {
  const secret = config.FIELD_ENCRYPTION_KEY;
  if (!secret) {
    // config.ts refuses to boot in production without the key, so this throw
    // only guards a path that somehow got past the gate. Failing here is
    // cheaper than encrypting regulated data under a public constant.
    if (config.NODE_ENV === 'production') {
      throw new Error('FIELD_ENCRYPTION_KEY is required in production');
    }
    if (!warnedAboutDevKey) {
      warnedAboutDevKey = true;
      // eslint-disable-next-line no-console
      console.warn(
        '[compliance/privacy] FIELD_ENCRYPTION_KEY is not set. Falling back to a well-known development key — ' +
          'regulated fields encrypted under it are not protected against anyone with the source. Set ' +
          'FIELD_ENCRYPTION_KEY before this reaches a real deployment.',
      );
    }
  }
  return scryptSync(secret ?? DEV_ENCRYPTION_KEY, 'kaizen-field-encryption-v1', 32);
}

/** AES-256-GCM. The IV, the auth tag and the ciphertext travel together in the
 * stored string, `enc:v1:`-prefixed so a plaintext legacy value is always
 * distinguishable from an encrypted one. */
export function encryptField(plaintext: string): string {
  const key = encryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENCRYPTED_FIELD_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

export function decryptField(value: string): string {
  if (!isEncryptedFieldValue(value)) return value;
  const [ivB64, tagB64, dataB64] = value.slice(ENCRYPTED_FIELD_PREFIX.length).split(':');
  const key = encryptionKey();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return plaintext.toString('utf8');
}

/** Reads a regulated column: decrypts it if it carries the `enc:v1:` marker,
 * returns it as-is otherwise (not yet migrated) — the one function every
 * write path outside this module should read PAN/Aadhaar/bank through. */
export function readRegulated(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return decryptField(value);
}

/** EmploymentRelationship columns backfill touches. Bank IFSC is a routing
 * code rather than an identifier on its own, but it sits next to the account
 * number on the same regulated row, so it travels with it. */
const REGULATED_EMPLOYMENT_FIELDS = ['panNumber', 'aadhaarReference', 'bankAccountNumber', 'bankAccountName', 'bankIfsc'] as const;

export async function backfillEncryptAtRest(): Promise<{ fieldsScanned: number; valuesEncrypted: number; alreadyEncrypted: number }> {
  const auth = currentAuth();
  await assertCan({ resource: 'security_settings', verb: 'edit' });

  const rows = await unscopedPrisma.employmentRelationship.findMany({
    where: { tenantId: auth.tenantId },
    select: { id: true, panNumber: true, aadhaarReference: true, bankAccountNumber: true, bankAccountName: true, bankIfsc: true },
  });

  let fieldsScanned = 0;
  let valuesEncrypted = 0;
  let alreadyEncrypted = 0;

  for (const row of rows) {
    const patch: Record<string, string> = {};
    for (const field of REGULATED_EMPLOYMENT_FIELDS) {
      const value = row[field];
      if (!value) continue;
      fieldsScanned += 1;
      if (isEncryptedFieldValue(value)) {
        alreadyEncrypted += 1;
        continue;
      }
      patch[field] = encryptField(value);
      valuesEncrypted += 1;
    }
    if (Object.keys(patch).length) {
      await unscopedPrisma.employmentRelationship.update({ where: { id: row.id }, data: patch as never });
    }
  }

  await prisma.encryptionBackfillRun.create({
    data: { tenantId: auth.tenantId, fieldsScanned, valuesEncrypted, alreadyEncrypted, runById: auth.partyId },
  });
  await auditBulkOperation('employment_relationship', 'encrypt_at_rest_backfill', { fieldsScanned, valuesEncrypted, alreadyEncrypted });

  return { fieldsScanned, valuesEncrypted, alreadyEncrypted };
}

export async function encryptionStatus() {
  const auth = currentAuth();
  await assertCan({ resource: 'security_settings', verb: 'view' });

  const rows = await unscopedPrisma.employmentRelationship.findMany({
    where: { tenantId: auth.tenantId },
    select: { panNumber: true, aadhaarReference: true, bankAccountNumber: true, bankAccountName: true, bankIfsc: true },
  });
  let plaintext = 0;
  let encrypted = 0;
  for (const row of rows) {
    for (const field of REGULATED_EMPLOYMENT_FIELDS) {
      const value = row[field];
      if (!value) continue;
      if (isEncryptedFieldValue(value)) encrypted += 1;
      else plaintext += 1;
    }
  }

  const lastRun = await prisma.encryptionBackfillRun.findFirst({ where: { tenantId: auth.tenantId }, orderBy: { ranAt: 'desc' } });
  return { plaintext, encrypted, lastRun, keyConfigured: Boolean(config.FIELD_ENCRYPTION_KEY) };
}

export type { PurposeCode };
export { PURPOSE_CODES };
