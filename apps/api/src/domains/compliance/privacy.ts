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
import { currentAuth, type AuthContext } from '../../platform/context.js';
import { emit } from '../../platform/eventBus.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { ApiError } from '../../platform/errors.js';
import { auditWrite, auditExport, auditBulkOperation, registerGovernedEntities } from '../../platform/audit.js';
import { assertCan } from '../../platform/permissions.js';
import { raiseException } from '../../platform/exceptions.js';
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
    force: true,
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
      status: 'granted',
      grantedAt: new Date(),
      channel: input.channel,
      evidence: (input.evidence ?? {}) as never,
      guardianOfPersonId: input.guardianOfPersonId ?? null,
      expiresAt: input.expiresAt ?? null,
    },
  });

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
  return prisma.consent.findMany({ where: { tenantId: auth.tenantId, personId }, orderBy: { createdAt: 'desc' } });
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
}

/**
 * CMP-DPD-003. If `dateOfBirth` puts the student under 18, refuses unless a
 * guardian name and phone are given, and returns the id of the Consent row
 * recorded for them so the caller can stamp `guardianConsentId`. Returns
 * `null` when the student is not (measurably) a minor — nothing to gate.
 */
export async function requireGuardianConsentForMinor(input: MinorGateInput): Promise<string | null> {
  if (isMinor(input.dateOfBirth) !== true) return null;

  if (!input.guardianName?.trim() || !input.guardianPhone?.trim()) {
    throw ApiError.badRequest(
      `This student is under 18 (age ${ageInYears(input.dateOfBirth)}). A minor cannot be enrolled without a named guardian and a recorded guardian consent — give a guardian name and phone.`,
      { reason: 'MINOR_GUARDIAN_CONSENT_REQUIRED' },
    );
  }

  const auth = currentAuth();
  const consent = await prisma.consent.create({
    data: {
      tenantId: auth.tenantId,
      personId: input.personId,
      purposeCode: 'education_delivery',
      status: 'granted',
      grantedAt: new Date(),
      channel: 'guardian_intake',
      evidence: { guardianName: input.guardianName, guardianPhone: input.guardianPhone } as never,
      guardianOfPersonId: input.personId,
    },
  });

  await auditWrite({
    action: 'create',
    subjectType: 'consent',
    subjectId: consent.id,
    after: { purposeCode: 'education_delivery', guardianOfPersonId: input.personId },
    force: true,
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
  return prisma.dataPrincipalRequest.findMany({
    where: {
      tenantId: auth.tenantId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.personId ? { personId: filter.personId } : {}),
    },
    orderBy: { receivedAt: 'desc' },
    take: 200,
  });
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

  return { person, affiliations, employments: employmentsDecrypted, studentProfile, exportedAt: new Date().toISOString() };
}

/**
 * Everything an erasure request can be blocked by, named rather than merely
 * refused. CMP-DPD-002.
 */
async function erasureBlockers(tenantId: string, personId: string): Promise<{ retentionClass: string; earliestErasable: Date }[]> {
  const affiliations = await unscopedPrisma.affiliation.findMany({
    where: { tenantId, partyId: personId, statutoryRetentionFloor: true },
  });
  if (!affiliations.length) return [];

  const schedules = await unscopedPrisma.retentionSchedule.findMany({ where: { tenantId }, orderBy: { effectiveFrom: 'desc' } });
  const blockers: { retentionClass: string; earliestErasable: Date }[] = [];
  const now = new Date();

  for (const aff of affiliations) {
    const retentionClass = aff.affiliationType === 'student' ? 'student_record' : 'employee_record';
    const schedule = schedules.find((s) => s.retentionClass === retentionClass && s.effectiveFrom <= now);
    if (!schedule) continue; // Unmeasured, not "clear to erase" — but nothing to compare a date against either.
    const anchor = aff.effectiveTo ?? aff.effectiveFrom;
    const window = { retentionClass, years: schedule.years, anchor };
    if (!isPastRetentionWindow(window, now)) {
      blockers.push({ retentionClass, earliestErasable: earliestErasableDate(window) });
    }
  }
  return blockers;
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
    const before = await unscopedPrisma.person.findFirst({ where: { id: request.personId, tenantId: auth.tenantId } });
    const after = await prisma.person.update({ where: { id: request.personId }, data: input.correction as never });
    await auditWrite({
      action: 'update',
      subjectType: 'person',
      subjectId: request.personId,
      before: before as never,
      after: after as never,
      force: true,
    });
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
    const earliest = blockers.reduce((min, b) => (b.earliestErasable < min ? b.earliestErasable : min), blockers[0].earliestErasable);
    const refusalReason =
      `Blocked by the statutory retention floor on ${blockers.map((b) => b.retentionClass).join(', ')}. ` +
      `Not erasable before ${earliest.toISOString().slice(0, 10)}.`;
    const updated = await prisma.dataPrincipalRequest.update({
      where: { id },
      data: { status: 'refused', refusalReason },
    });
    await auditWrite({ action: 'update', subjectType: 'data_principal_request', subjectId: id, before: { status: request.status }, after: { status: 'refused', refusalReason } });
    return updated;
  }

  const token = `erased:${request.personId}`;
  await prisma.person.update({
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
      deletedAt: new Date(),
    } as never,
  });
  const updated = await prisma.dataPrincipalRequest.update({
    where: { id },
    data: { status: 'fulfilled', fulfilledAt: new Date(), response: { erased: true, token } as never },
  });
  await auditWrite({ action: 'delete', subjectType: 'person', subjectId: request.personId, after: { erased: true }, force: true });
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
    const [totalCount, pastWindowCount] = await Promise.all([
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
      force: true,
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
  const secret = process.env.FIELD_ENCRYPTION_KEY;
  if (!secret && !warnedAboutDevKey) {
    warnedAboutDevKey = true;
    // eslint-disable-next-line no-console
    console.warn(
      '[compliance/privacy] FIELD_ENCRYPTION_KEY is not set. Falling back to a well-known development key — ' +
        'regulated fields encrypted under it are not protected against anyone with the source. Set ' +
        'FIELD_ENCRYPTION_KEY before this reaches a real deployment.',
    );
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
  return { plaintext, encrypted, lastRun, keyConfigured: Boolean(process.env.FIELD_ENCRYPTION_KEY) };
}

export type { PurposeCode };
export { PURPOSE_CODES };
