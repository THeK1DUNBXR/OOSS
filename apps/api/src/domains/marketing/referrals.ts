/**
 * Referral & affiliate programs (MKT-REF-001 through MKT-REF-004).
 *
 * A referral moves along `REFERRAL_TRANSITIONS` (issued → used → qualified →
 * rewarded, void reachable from any non-terminal state). Marketing never
 * posts money: `reward()` stores only the caller-supplied
 * `rewardTransactionRef` — a reference into Finance's own ledger — never a
 * transaction of its own.
 */

import { EVENTS, REFERRAL_TRANSITIONS, type ReferralStatus } from '@kaizen/shared';
import { prisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { emit } from '../../platform/eventBus.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan } from '../../platform/permissions.js';
import { raiseException } from '../../platform/exceptions.js';
import { findOrCreatePerson, type PersonInput } from '../identity.js';
import { createLead } from '../leads.js';

// ---------------------------------------------------------------------------
// Programs
// ---------------------------------------------------------------------------

export interface ReferralProgramInput {
  name: string;
  kind: string;
  rewardKind?: string;
  rewardAmount?: number | null;
  terms?: string | null;
}

export async function createReferralProgram(input: ReferralProgramInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_referrals', verb: 'create' });

  const recordCode = await nextRecordCode('RFP');
  const program = await prisma.marketingReferralProgram.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      name: input.name,
      kind: input.kind,
      rewardKind: input.rewardKind ?? 'none',
      rewardAmount: input.rewardAmount ?? null,
      terms: input.terms ?? null,
      createdById: auth.partyId,
    },
  });
  return program;
}

export async function listReferralPrograms(filters: { active?: boolean } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_referrals', verb: 'view' });
  return prisma.marketingReferralProgram.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, ...(filters.active !== undefined ? { active: filters.active } : {}) },
    orderBy: { createdAt: 'desc' },
  });
}

export async function loadReferralProgram(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_referrals', verb: 'view' });
  const program = await prisma.marketingReferralProgram.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!program) throw ApiError.notFound('Referral program');
  return program;
}

export async function updateReferralProgram(id: string, patch: Partial<ReferralProgramInput>) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_referrals', verb: 'edit' });
  const program = await prisma.marketingReferralProgram.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!program) throw ApiError.notFound('Referral program');
  return prisma.marketingReferralProgram.update({
    where: { id },
    data: {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.rewardKind !== undefined ? { rewardKind: patch.rewardKind } : {}),
      ...(patch.rewardAmount !== undefined ? { rewardAmount: patch.rewardAmount } : {}),
      ...(patch.terms !== undefined ? { terms: patch.terms } : {}),
      updatedById: auth.partyId,
    },
  });
}

async function setProgramActive(id: string, active: boolean) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_referrals', verb: 'edit' });
  const program = await prisma.marketingReferralProgram.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!program) throw ApiError.notFound('Referral program');
  return prisma.marketingReferralProgram.update({ where: { id }, data: { active } });
}

export const activateReferralProgram = (id: string) => setProgramActive(id, true);
export const deactivateReferralProgram = (id: string) => setProgramActive(id, false);

// ---------------------------------------------------------------------------
// Referral codes
// ---------------------------------------------------------------------------

/** Crockford base32 minus visually ambiguous characters — matches RECORD_CODE conventions elsewhere in the platform. */
const BASE32_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomBase32(length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += BASE32_ALPHABET[Math.floor(Math.random() * BASE32_ALPHABET.length)];
  }
  return out;
}

function programPrefix(program: { kind: string }): string {
  return program.kind.slice(0, 3).toUpperCase().padEnd(3, 'X');
}

export interface IssueReferralInput {
  programId: string;
  referrerPersonId?: string | null;
  referrerOrganizationId?: string | null;
}

export async function issueReferral(input: IssueReferralInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_referrals', verb: 'create' });

  if (!input.referrerPersonId && !input.referrerOrganizationId) {
    throw ApiError.badRequest('A referral requires a referrer — a person or an organization.');
  }

  const program = await prisma.marketingReferralProgram.findFirst({
    where: { id: input.programId, tenantId: auth.tenantId, deletedAt: null },
  });
  if (!program) throw ApiError.notFound('Referral program');
  if (!program.active) throw ApiError.conflict('This referral program is not active.');

  const prefix = programPrefix(program);
  let code = '';
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = `${prefix}${randomBase32(6)}`;
    const clash = await prisma.marketingReferral.findFirst({ where: { tenantId: auth.tenantId, code: candidate } });
    if (!clash) {
      code = candidate;
      break;
    }
  }
  if (!code) throw ApiError.internal('Could not allocate a unique referral code after 10 attempts.');

  const recordCode = await nextRecordCode('REF');
  const referral = await prisma.marketingReferral.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      programId: program.id,
      referrerPersonId: input.referrerPersonId ?? null,
      referrerOrganizationId: input.referrerOrganizationId ?? null,
      code,
      createdById: auth.partyId,
    },
  });

  await emit({
    name: EVENTS.MKT_REFERRAL_ISSUED,
    subject: { entityType: 'referral', entityId: referral.id, recordCode },
    newState: { status: referral.status, code },
  });

  return referral;
}

export async function listReferrals(filters: { programId?: string; status?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_referrals', verb: 'view' });
  return prisma.marketingReferral.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      ...(filters.programId ? { programId: filters.programId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
}

export interface RedeemReferralInput {
  code: string;
  referredPersonId?: string;
  person?: PersonInput;
}

/**
 * Redeeming a code creates or finds the referred person (via
 * `findOrCreatePerson`, never a bespoke insert), records a `referral`
 * touchpoint, and opens a Lead with `source: 'referral'` and
 * `sourceDetail` carrying the code itself — a referral lead is never
 * attributed to a campaign, so campaignId/channelKey are cleared explicitly
 * on the Lead row after `createLead` returns.
 */
export async function redeemReferral(input: RedeemReferralInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_referrals', verb: 'edit' });

  const referral = await prisma.marketingReferral.findFirst({ where: { tenantId: auth.tenantId, code: input.code } });
  if (!referral) throw ApiError.notFound('Referral code');
  if (referral.status !== 'issued') throw ApiError.conflict(`This referral code is already ${referral.status}.`);

  let referredPersonId = input.referredPersonId ?? null;
  if (!referredPersonId && input.person) {
    const resolved = await findOrCreatePerson(input.person);
    referredPersonId = resolved.person.id;
  }
  if (!referredPersonId) throw ApiError.badRequest('Redeeming a referral requires referredPersonId or an inline person.');

  if (referral.referrerPersonId && referral.referrerPersonId === referredPersonId) {
    throw ApiError.conflict('A person cannot redeem their own referral code.');
  }

  const lead = await createLead({
    title: `Referral — ${referral.code}`,
    personId: referredPersonId,
    vertical: 'other',
    source: 'referral',
    sourceDetail: referral.code,
  });
  // A referral lead is never campaign-attributed — the referral itself is the
  // channel, independent of any live campaign that happened to be running.
  await prisma.lead.update({ where: { id: lead.id }, data: { campaignId: null, channelKey: 'referral' } });

  await prisma.marketingTouchpoint.create({
    data: {
      tenantId: auth.tenantId,
      personId: referredPersonId,
      leadId: lead.id,
      channelKey: 'referral',
      touchKind: 'referral',
      occurredAt: new Date(),
      utm: {},
      sourceRef: referral.code,
    },
  });

  const updated = await prisma.marketingReferral.update({
    where: { id: referral.id },
    data: { status: 'used', referredPersonId, leadId: lead.id },
  });

  await emit({
    name: EVENTS.MKT_REFERRAL_USED,
    subject: { entityType: 'referral', entityId: referral.id, recordCode: referral.recordCode },
    related: [
      { relation: 'referred', entityType: 'person', entityId: referredPersonId },
      { relation: 'created_lead', entityType: 'lead', entityId: lead.id },
    ],
    previousState: { status: 'issued' },
    newState: { status: 'used' },
  });

  return updated;
}

async function transitionReferral(id: string, to: ReferralStatus) {
  const auth = currentAuth();
  const referral = await prisma.marketingReferral.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!referral) throw ApiError.notFound('Referral');
  const from = referral.status as ReferralStatus;
  const allowed = REFERRAL_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) throw ApiError.unprocessable(`Cannot move a ${from} referral to ${to}.`);
  return { referral, from };
}

/** Qualification is an explicit call — the caller (CRM's own conversion path, or an operator) attests the underlying lead converted or an enrolment exists. */
export async function qualifyReferral(id: string) {
  await assertCan({ resource: 'marketing_referrals', verb: 'edit' });
  const { referral, from } = await transitionReferral(id, 'qualified');
  const updated = await prisma.marketingReferral.update({ where: { id }, data: { status: 'qualified' } });
  await emit({
    name: EVENTS.MKT_REFERRAL_QUALIFIED,
    subject: { entityType: 'referral', entityId: id, recordCode: referral.recordCode },
    previousState: { status: from },
    newState: { status: 'qualified' },
  });
  return updated;
}

export async function rewardReferral(id: string, rewardTransactionRef?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_referrals', verb: 'edit' });
  const { referral, from } = await transitionReferral(id, 'rewarded');

  const program = await prisma.marketingReferralProgram.findFirst({ where: { id: referral.programId } });
  if (program?.rewardKind === 'none') {
    throw ApiError.conflict('This referral program carries no reward — nothing to record.');
  }

  const updated = await prisma.marketingReferral.update({
    where: { id },
    data: { status: 'rewarded', rewardTransactionRef: rewardTransactionRef ?? null, updatedById: auth.partyId },
  });
  await emit({
    name: EVENTS.MKT_REFERRAL_REWARDED,
    subject: { entityType: 'referral', entityId: id, recordCode: referral.recordCode },
    previousState: { status: from },
    newState: { status: 'rewarded', rewardTransactionRef: rewardTransactionRef ?? null },
  });
  return updated;
}

export async function voidReferral(id: string, reason: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_referrals', verb: 'edit' });
  const { referral, from } = await transitionReferral(id, 'void');
  const updated = await prisma.marketingReferral.update({ where: { id }, data: { status: 'void', updatedById: auth.partyId } });
  await emit({
    name: EVENTS.MKT_REFERRAL_VOIDED,
    subject: { entityType: 'referral', entityId: id, recordCode: referral.recordCode },
    previousState: { status: from },
    newState: { status: 'void' },
    reason: { reasonCode: 'voided', note: reason },
  });
  return updated;
}

export interface LeaderboardRow {
  referrerLabel: string;
  issued: number;
  used: number;
  qualified: number;
  rewarded: number;
}

export async function leaderboard(programId: string): Promise<LeaderboardRow[]> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_referrals', verb: 'view' });

  const referrals = await prisma.marketingReferral.findMany({ where: { tenantId: auth.tenantId, programId, deletedAt: null } });

  const personIds = [...new Set(referrals.map((r) => r.referrerPersonId).filter((x): x is string => Boolean(x)))];
  const orgIds = [...new Set(referrals.map((r) => r.referrerOrganizationId).filter((x): x is string => Boolean(x)))];
  const [people, orgs] = await Promise.all([
    personIds.length ? prisma.person.findMany({ where: { id: { in: personIds } }, select: { id: true, fullName: true } }) : [],
    orgIds.length ? prisma.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } }) : [],
  ]);
  const personName = new Map(people.map((p) => [p.id, p.fullName]));
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));

  const byReferrer = new Map<string, LeaderboardRow>();
  for (const r of referrals) {
    const key = r.referrerPersonId ?? r.referrerOrganizationId ?? 'unknown';
    const label = r.referrerPersonId
      ? (personName.get(r.referrerPersonId) ?? 'Unknown')
      : r.referrerOrganizationId
        ? (orgName.get(r.referrerOrganizationId) ?? 'Unknown')
        : 'Unknown';
    const row = byReferrer.get(key) ?? { referrerLabel: label, issued: 0, used: 0, qualified: 0, rewarded: 0 };
    row.issued += 1;
    if (['used', 'qualified', 'rewarded'].includes(r.status)) row.used += 1;
    if (['qualified', 'rewarded'].includes(r.status)) row.qualified += 1;
    if (r.status === 'rewarded') row.rewarded += 1;
    byReferrer.set(key, row);
  }

  return [...byReferrer.values()].sort((a, b) => b.rewarded - a.rewarded || b.qualified - a.qualified || b.issued - a.issued);
}

/** EX-MKT-013: a qualified referral not rewarded more than 30 days later. */
export async function detectRewardsPending(thresholdDays = 30): Promise<number> {
  const auth = currentAuth();
  const cutoff = new Date(Date.now() - thresholdDays * 86_400_000);

  const stale = await prisma.marketingReferral.findMany({
    where: { tenantId: auth.tenantId, status: 'qualified', updatedAt: { lt: cutoff } },
    take: 200,
  });

  for (const referral of stale) {
    await raiseException({
      code: 'EX-MKT-013',
      label: 'Referral reward pending beyond 30 days',
      severity: 'S1_ATTENTION',
      subjectType: 'referral',
      subjectId: referral.id,
      subjectLabel: `${referral.recordCode} (${referral.code})`,
      domain: 'mkt',
      detail: `Qualified more than ${thresholdDays} days ago and still not rewarded.`,
      ownerPartyId: referral.createdById,
      triggerFingerprint: `mkt_referral_reward_pending:${thresholdDays}`,
      ladderRung: 1,
    });
  }
  return stale.length;
}

export interface ReferralInput {
  code: string;
  referredPersonId?: string;
}
