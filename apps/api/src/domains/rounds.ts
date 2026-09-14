/**
 * Rounds, instruments, valuations, scenarios (bounded context `eqt`) —
 * equity-portal plan §6 phase 4.
 *
 * A `FundingRound` is the container an allotment, a bonus, a rights offer, a
 * buy-back or a capital reduction is struck under. Opening one enforces the
 * statutory prerequisite its kind names (a valuer's report, an offer letter
 * serial, a source of bonus) rather than trusting the caller to have checked;
 * closing one totals what actually went effective under it and raises the
 * PAS-3 filing item the close creates.
 *
 * Every instrument event below — conversion, redemption, buy-back, bonus —
 * is a `ShareTransaction` and goes through the exact propose → approve →
 * effective path `equity.ts` already built: this file proposes the row,
 * `equity.ts`'s `approveShareTransaction` and `makeEffective` decide and post
 * it. Nothing here duplicates that machinery.
 *
 * `modelRound`/`waterfall` in `@kaizen/shared` are pure; this file's scenario
 * endpoints read the live cap table and hand it to them, and write nothing —
 * a scenario is arithmetic about a hypothesis, never a fact about the company
 * (EQT-RND-008).
 */

import {
  EVENTS,
  isTrading,
  financialYearOf,
  loanBalanceAt,
  modelRound,
  waterfall,
  type ConversionTerms,
  type ModelRoundInput,
  type ScenarioCapTableRow,
} from '@kaizen/shared';
import { prisma, dec, num } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { assertCan } from '../platform/permissions.js';
import { ApiError } from '../platform/errors.js';
import { auditWrite } from '../platform/audit.js';
import { emit } from '../platform/eventBus.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { raiseException } from '../platform/exceptions.js';
import { effectiveBalance, shareTransactionView, holderView, outgoingCount } from './equity.js';

// ---------------------------------------------------------------------------
// Rounds
// ---------------------------------------------------------------------------

export interface FundingRoundInput {
  name: string;
  kind: string;
  preMoneyValuation?: number | null;
  pricePerShareByClass?: Record<string, number> | null;
  valuationId?: string | null;
  boardResolutionRef?: string | null;
  shareholderResolutionRef?: string | null;
  mgt14Srn?: string | null;
  offerLetterSerial?: string | null;
  separateBankAccountRef?: string | null;
  offereeCount?: number | null;
  renunciationAllowed?: boolean | null;
  sourceOfBonus?: string | null;
  valuationReportRef?: string | null;
  tribunalOrderRef?: string | null;
  notes?: string | null;
}

export async function createRound(input: FundingRoundInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'rounds', verb: 'create' });

  if (!input.name.trim()) throw ApiError.badRequest('A round needs a name.');

  const row = await prisma.fundingRound.create({
    data: {
      tenantId: auth.tenantId,
      recordCode: await nextRecordCode('RND'),
      name: input.name,
      kind: input.kind,
      status: 'draft',
      preMoneyValuation: input.preMoneyValuation == null ? null : dec(input.preMoneyValuation),
      pricePerShareByClass: (input.pricePerShareByClass ?? undefined) as never,
      valuationId: input.valuationId ?? null,
      boardResolutionRef: input.boardResolutionRef ?? null,
      shareholderResolutionRef: input.shareholderResolutionRef ?? null,
      mgt14Srn: input.mgt14Srn ?? null,
      offerLetterSerial: input.offerLetterSerial ?? null,
      separateBankAccountRef: input.separateBankAccountRef ?? null,
      offereeCount: input.offereeCount ?? null,
      renunciationAllowed: input.renunciationAllowed ?? null,
      sourceOfBonus: input.sourceOfBonus ?? null,
      valuationReportRef: input.valuationReportRef ?? null,
      tribunalOrderRef: input.tribunalOrderRef ?? null,
      notes: input.notes ?? null,
    },
  });

  await auditWrite({ action: 'create', subjectType: 'funding_round', subjectId: row.id, after: row as never });
  await emit({
    name: EVENTS.ROUND_CREATED,
    subject: { entityType: 'funding_round', entityId: row.id, recordCode: row.recordCode },
    newState: { name: row.name, kind: row.kind },
  });

  return fundingRoundView(row);
}

export async function updateRound(id: string, input: Partial<FundingRoundInput>) {
  const auth = currentAuth();
  await assertCan({ resource: 'rounds', verb: 'edit' });

  const existing = await prisma.fundingRound.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!existing) throw ApiError.notFound('Round');
  if (existing.status !== 'draft') {
    throw ApiError.conflict('Only a draft round can be edited; an open or closed round is a record of what actually happened.');
  }

  const updated = await prisma.fundingRound.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.preMoneyValuation !== undefined ? { preMoneyValuation: input.preMoneyValuation == null ? null : dec(input.preMoneyValuation) } : {}),
      ...(input.pricePerShareByClass !== undefined ? { pricePerShareByClass: (input.pricePerShareByClass ?? undefined) as never } : {}),
      ...(input.valuationId !== undefined ? { valuationId: input.valuationId } : {}),
      ...(input.boardResolutionRef !== undefined ? { boardResolutionRef: input.boardResolutionRef } : {}),
      ...(input.shareholderResolutionRef !== undefined ? { shareholderResolutionRef: input.shareholderResolutionRef } : {}),
      ...(input.mgt14Srn !== undefined ? { mgt14Srn: input.mgt14Srn } : {}),
      ...(input.offerLetterSerial !== undefined ? { offerLetterSerial: input.offerLetterSerial } : {}),
      ...(input.separateBankAccountRef !== undefined ? { separateBankAccountRef: input.separateBankAccountRef } : {}),
      ...(input.offereeCount !== undefined ? { offereeCount: input.offereeCount } : {}),
      ...(input.renunciationAllowed !== undefined ? { renunciationAllowed: input.renunciationAllowed } : {}),
      ...(input.sourceOfBonus !== undefined ? { sourceOfBonus: input.sourceOfBonus } : {}),
      ...(input.valuationReportRef !== undefined ? { valuationReportRef: input.valuationReportRef } : {}),
      ...(input.tribunalOrderRef !== undefined ? { tribunalOrderRef: input.tribunalOrderRef } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    },
  });

  await auditWrite({ action: 'update', subjectType: 'funding_round', subjectId: id, before: existing as never, after: updated as never });
  return fundingRoundView(updated);
}

export async function listRounds() {
  const auth = currentAuth();
  await assertCan({ resource: 'rounds', verb: 'view' });
  const rows = await prisma.fundingRound.findMany({ where: { tenantId: auth.tenantId, deletedAt: null }, orderBy: { createdAt: 'desc' } });
  return rows.map(fundingRoundView);
}

export async function round(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'rounds', verb: 'view' });
  const row = await prisma.fundingRound.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Round');

  const transactions = await prisma.shareTransaction.findMany({
    where: { tenantId: auth.tenantId, roundId: id },
    orderBy: { createdAt: 'asc' },
  });

  const effective = transactions.filter((t) => t.status === 'effective');
  const raised = effective
    .filter((t) => t.type === 'allotment' && t.pricePerShare)
    .reduce((sum, t) => sum + (num(t.count) ?? 0) * (num(t.pricePerShare) ?? 0), 0);

  return {
    round: fundingRoundView(row),
    transactions: transactions.map(shareTransactionView),
    raised: round2(raised),
    postMoney: row.preMoneyValuation != null ? round2((num(row.preMoneyValuation) ?? 0) + raised) : null,
  };
}

/**
 * Validates the statutory prerequisite named by kind, then opens the round.
 * A failure names the section it is refusing under, the way every other
 * refusal in this domain does.
 */
export async function openRound(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'rounds', verb: 'approve' });

  const row = await prisma.fundingRound.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Round');
  if (row.status !== 'draft') throw ApiError.conflict(`This round is already ${row.status}.`);

  if (row.kind === 'preferential' || row.kind === 'private_placement') {
    if (!row.valuationId) {
      throw ApiError.unprocessable(
        'Rule 13 of the Companies (Share Capital and Debentures) Rules: a preferential allotment or a private ' +
          "placement needs a registered valuer's report before it may open. This round carries no valuationId.",
      );
    }
    const valuation = await prisma.valuation.findFirst({ where: { id: row.valuationId, tenantId: auth.tenantId } });
    if (!valuation) throw ApiError.notFound('Valuation');
    if (valuation.basis !== 'registered_valuer') {
      throw ApiError.unprocessable(
        `Rule 13 needs the linked valuation on a registered_valuer basis; this one is recorded on a "${valuation.basis}" basis.`,
      );
    }
    if (valuation.asOf >= new Date()) {
      throw ApiError.unprocessable("Rule 13 needs the registered valuer's report dated before opening; this one is not.");
    }
  }

  if (row.kind === 'private_placement') {
    if (!row.offerLetterSerial) {
      throw ApiError.unprocessable('s.42 needs a PAS-4 offer letter serial before a private placement may open.');
    }
    if (!row.separateBankAccountRef) {
      throw ApiError.unprocessable('s.42 needs a separate bank account reference before a private placement may open.');
    }
    if (row.offereeCount == null || row.offereeCount <= 0) {
      throw ApiError.unprocessable('s.42 needs the number of persons this round will be offered to before it may open.');
    }

    const fy = financialYearOf(new Date());
    const others = await prisma.fundingRound.findMany({
      where: { tenantId: auth.tenantId, kind: 'private_placement', status: { in: ['open', 'closed'] }, id: { not: row.id } },
    });
    const othersThisFy = others.filter((r) => r.openedOn && financialYearOf(r.openedOn) === fy);
    const priorCount = othersThisFy.reduce((sum, r) => sum + (r.offereeCount ?? 0), 0);
    const total = priorCount + row.offereeCount;
    if (total > 200) {
      throw ApiError.unprocessable(
        `s.42 caps private placement offerees at 200 persons in a financial year. ${priorCount} have already been ` +
          `offered shares in ${fy} across other private-placement rounds; this round's ${row.offereeCount} would take the year to ${total}.`,
      );
    }
  }

  if (row.kind === 'bonus') {
    if (!row.sourceOfBonus) {
      throw ApiError.unprocessable('s.63 needs a named source (free reserves, securities premium, or the capital redemption reserve) before a bonus round may open.');
    }
    if (row.sourceOfBonus === 'free_reserves') {
      const reserves = await freeReservesProxy();
      if (!reserves.measured) {
        throw ApiError.unprocessable(
          `s.63 requires free reserves to exist before a bonus is declared from them. ${reserves.basis}`,
        );
      }
      if (reserves.amount <= 0) {
        throw ApiError.unprocessable(
          `s.63 requires free reserves to exist before a bonus is declared from them. Measured cumulative retained ` +
            `profit is ${reserves.amount}, which is not positive.`,
        );
      }
    }
  }

  if (row.kind === 'sweat_equity' && !row.valuationReportRef) {
    throw ApiError.unprocessable('s.54 needs a valuation report reference before a sweat-equity round may open.');
  }

  if (row.kind === 'capital_reduction' && !row.tribunalOrderRef) {
    throw ApiError.unprocessable('s.66 needs the tribunal order this reduction is recorded against before it may open.');
  }

  if (row.kind === 'buyback') {
    const tests = await buybackTests();
    if (!tests.freeReserves.measured) {
      throw ApiError.unprocessable(`s.68 needs free reserves to be measurable before a buy-back round may open. ${tests.freeReserves.basis}`);
    }
  }

  const updated = await prisma.fundingRound.update({ where: { id }, data: { status: 'open', openedOn: new Date() } });
  await auditWrite({ action: 'update', subjectType: 'funding_round', subjectId: id, before: row as never, after: updated as never });
  await emit({
    name: EVENTS.ROUND_OPENED,
    subject: { entityType: 'funding_round', entityId: id, recordCode: row.recordCode },
    newState: { status: 'open', kind: row.kind },
  });

  return fundingRoundView(updated);
}

/**
 * Marks every effective transaction under the round, totals what was raised
 * and the post-money it implies, and raises the PAS-3 filing item — 15 days
 * for a private placement, 30 for everything else that allots shares (s.39).
 */
export async function closeRound(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'rounds', verb: 'approve' });

  const row = await prisma.fundingRound.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Round');
  if (row.status !== 'open') throw ApiError.conflict(`Only an open round can be closed; this one is ${row.status}.`);

  const transactions = await prisma.shareTransaction.findMany({ where: { tenantId: auth.tenantId, roundId: id, status: 'effective' } });
  const raised = transactions
    .filter((t) => t.type === 'allotment' && t.pricePerShare)
    .reduce((sum, t) => sum + (num(t.count) ?? 0) * (num(t.pricePerShare) ?? 0), 0);
  const postMoney = row.preMoneyValuation != null ? round2((num(row.preMoneyValuation) ?? 0) + raised) : null;

  const updated = await prisma.fundingRound.update({
    where: { id },
    data: { status: 'closed', closedOn: new Date(), raised: dec(round2(raised)), postMoneyValuation: postMoney == null ? null : dec(postMoney) },
  });

  await auditWrite({ action: 'update', subjectType: 'funding_round', subjectId: id, before: row as never, after: updated as never });
  await emit({
    name: EVENTS.ROUND_CLOSED,
    subject: { entityType: 'funding_round', entityId: id, recordCode: row.recordCode },
    newState: { status: 'closed', raised: round2(raised), postMoney },
  });

  const pas3Days = row.kind === 'private_placement' ? 15 : 30;
  const dueOn = new Date(Date.now() + pas3Days * 86_400_000);
  await raiseException({
    code: 'EX-EQT-003',
    label: 'PAS-3 return of allotment due',
    severity: 'S2_WARNING',
    subjectType: 'funding_round',
    subjectId: id,
    subjectLabel: row.recordCode,
    domain: 'eqt',
    detail:
      `s.39 requires a PAS-3 return of allotment within ${pas3Days} days of ${row.kind === 'private_placement' ? 'a private placement' : 'an allotment'} closing. ` +
      `${row.recordCode} closed on ${updated.closedOn!.toISOString().slice(0, 10)}; PAS-3 is due by ${dueOn.toISOString().slice(0, 10)}.`,
    reasonCode: 'pas3_due',
    slaDueAt: dueOn,
    triggerFingerprint: `pas3_due:${id}`,
  });

  return fundingRoundView(updated);
}

export async function cancelRound(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'rounds', verb: 'approve' });

  const row = await prisma.fundingRound.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Round');
  if (row.status === 'closed') throw ApiError.conflict('A closed round cannot be cancelled — reverse the transactions under it instead.');

  const updated = await prisma.fundingRound.update({ where: { id }, data: { status: 'cancelled' } });
  await auditWrite({ action: 'update', subjectType: 'funding_round', subjectId: id, before: row as never, after: updated as never });
  await emit({
    name: EVENTS.ROUND_CANCELLED,
    subject: { entityType: 'funding_round', entityId: id, recordCode: row.recordCode },
    newState: { status: 'cancelled' },
  });
  return fundingRoundView(updated);
}

export function fundingRoundView(row: {
  id: string; recordCode: string; name: string; kind: string; status: string; openedOn: Date | null; closedOn: Date | null;
  preMoneyValuation: unknown; postMoneyValuation: unknown; raised: unknown; pricePerShareByClass: unknown; valuationId: string | null;
  boardResolutionRef: string | null; shareholderResolutionRef: string | null; mgt14Srn: string | null; pas3Srn: string | null;
  pas3FiledOn: Date | null; offerLetterSerial: string | null; separateBankAccountRef: string | null; offereeCount: number | null;
  renunciationAllowed: boolean | null; sourceOfBonus: string | null; valuationReportRef: string | null; tribunalOrderRef: string | null;
  notes: string | null;
}) {
  return {
    id: row.id,
    recordCode: row.recordCode,
    name: row.name,
    kind: row.kind,
    status: row.status,
    openedOn: row.openedOn ? row.openedOn.toISOString() : null,
    closedOn: row.closedOn ? row.closedOn.toISOString() : null,
    preMoneyValuation: num(row.preMoneyValuation as never),
    postMoneyValuation: num(row.postMoneyValuation as never),
    raised: num(row.raised as never),
    pricePerShareByClass: (row.pricePerShareByClass ?? null) as Record<string, number> | null,
    valuationId: row.valuationId,
    boardResolutionRef: row.boardResolutionRef,
    shareholderResolutionRef: row.shareholderResolutionRef,
    mgt14Srn: row.mgt14Srn,
    pas3Srn: row.pas3Srn,
    pas3FiledOn: row.pas3FiledOn ? row.pas3FiledOn.toISOString() : null,
    offerLetterSerial: row.offerLetterSerial,
    separateBankAccountRef: row.separateBankAccountRef,
    offereeCount: row.offereeCount,
    renunciationAllowed: row.renunciationAllowed,
    sourceOfBonus: row.sourceOfBonus,
    valuationReportRef: row.valuationReportRef,
    tribunalOrderRef: row.tribunalOrderRef,
    notes: row.notes,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Free reserves & the buy-back tests — proxies computed honestly from the
// books, never invented (§0 house rule: "not measured" is never zero).
// ---------------------------------------------------------------------------

export interface FreeReservesResult {
  measured: boolean;
  amount: number;
  basis: string;
}

/**
 * The books do not carry a statutory "free reserves" figure — no ledger
 * account distinguishes a free reserve from a statutory one, and dividends
 * declared out of reserves are not tracked separately. The honest proxy
 * available is cumulative trading profit and loss across every period the
 * books have ever recorded (§15's own `isTrading` split, applied over every
 * transaction rather than one period at a time) — stated as a proxy, not
 * presented as the statutory figure, and refused as "not measured" rather
 * than assumed to be zero when the books carry nothing to sum.
 */
export async function freeReservesProxy(): Promise<FreeReservesResult> {
  const auth = currentAuth();
  const totalTxns = await prisma.transaction.count({ where: { tenantId: auth.tenantId, deletedAt: null } });
  if (totalTxns === 0) {
    return {
      measured: false,
      amount: 0,
      basis: 'No transactions are recorded in the books, so cumulative retained profit — the proxy this platform uses for free reserves — cannot be computed.',
    };
  }

  const rows = await prisma.transaction.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null },
    select: { amount: true, direction: true, category: { select: { kind: true } } },
  });

  let net = 0;
  for (const r of rows) {
    if (!isTrading(r.category?.kind)) continue;
    const amt = num(r.amount) ?? 0;
    net += r.direction === 'in' ? amt : -amt;
  }

  return {
    measured: true,
    amount: round2(net),
    basis: 'Cumulative trading profit and loss across every recorded period (a proxy for free reserves; not adjusted for declared dividends or statutory reserve transfers).',
  };
}

export interface BuybackTests {
  paidUpCapital: number;
  securitiesPremium: number;
  freeReserves: FreeReservesResult;
  totalDebt: number;
  /** 10% of paid-up equity capital + free reserves — the board-resolution ceiling. */
  boardCeiling: number | null;
  /** 25% of paid-up equity capital + free reserves — the special-resolution ceiling. */
  specialResolutionCeiling: number | null;
  /** Post-buy-back debt / (paid-up capital + free reserves) must stay ≤ 2. */
  debtEquityRatio: number | null;
}

/**
 * The s.68 tests, computed from the register and the books: paid-up capital
 * and securities premium from the cap table and the ledger of allotments,
 * free reserves from `freeReservesProxy`, debt from `Loan`. Every input is
 * either an authoritative platform figure (the register, the loan book) or
 * refused as unmeasured — nothing here is approximated past what the data
 * supports.
 */
export async function buybackTests(): Promise<BuybackTests> {
  const auth = currentAuth();

  const classes = await prisma.shareClass.findMany({
    where: { tenantId: auth.tenantId, kind: { in: ['equity', 'preference'] } },
  });
  const classById = new Map(classes.map((c) => [c.id, c]));

  const txns = await prisma.shareTransaction.findMany({
    where: { tenantId: auth.tenantId, status: 'effective' },
  });

  let paidUpCapital = 0;
  let securitiesPremium = 0;
  for (const t of txns) {
    const amount = num(t.count) ?? 0;
    const price = num(t.pricePerShare) ?? 0;

    // Incoming leg: allotted into a share-capital class.
    const inClass = classById.get(t.shareClassId);
    if (t.toHolderId && inClass) {
      paidUpCapital += amount * (num(inClass.faceValue) ?? 0);
      if (price > (num(inClass.faceValue) ?? 0)) {
        securitiesPremium += amount * (price - (num(inClass.faceValue) ?? 0));
      }
    }

    // Outgoing leg: retired from a share-capital class — a conversion's
    // source class (`fromShareClassId`) at its own count (`meta.sourceCount`,
    // never the row's `count`, which names the target side), the row's own
    // class and count otherwise (redemption, buy-back).
    const outClassId = t.type === 'conversion' && t.fromShareClassId ? t.fromShareClassId : t.shareClassId;
    const outClass = classById.get(outClassId);
    if (t.fromHolderId && outClass) {
      paidUpCapital -= outgoingCount(t) * (num(outClass.faceValue) ?? 0);
    }
  }
  paidUpCapital = round2(Math.max(0, paidUpCapital));
  securitiesPremium = round2(Math.max(0, securitiesPremium));

  const freeReserves = await freeReservesProxy();

  const loans = await prisma.loan.findMany({ where: { tenantId: auth.tenantId, deletedAt: null, closedAt: null } });
  const totalDebt = round2(
    loans.reduce((sum, l) => {
      const outstanding = loanBalanceAt(
        { principal: num(l.principal) ?? 0, annualRate: num(l.annualRate) ?? 0, tenureMonths: l.tenureMonths, startDate: l.startDate },
        new Date(),
      );
      return sum + outstanding;
    }, 0),
  );

  if (!freeReserves.measured) {
    return {
      paidUpCapital,
      securitiesPremium,
      freeReserves,
      totalDebt,
      boardCeiling: null,
      specialResolutionCeiling: null,
      debtEquityRatio: null,
    };
  }

  const base = paidUpCapital + freeReserves.amount;
  const equityBase = paidUpCapital + securitiesPremium + freeReserves.amount;
  return {
    paidUpCapital,
    securitiesPremium,
    freeReserves,
    totalDebt,
    boardCeiling: round2(base * 0.1),
    specialResolutionCeiling: round2(base * 0.25),
    debtEquityRatio: equityBase > 0 ? round2(totalDebt / equityBase) : null,
  };
}

// ---------------------------------------------------------------------------
// Instruments: conversion, redemption, buy-back, bonus, rights issue
// ---------------------------------------------------------------------------

async function requireOpenRoundOfKind(roundId: string, kinds: string[]) {
  const auth = currentAuth();
  const row = await prisma.fundingRound.findFirst({ where: { id: roundId, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Round');
  if (row.status !== 'open') throw ApiError.unprocessable(`This round is ${row.status}, not open — nothing may be proposed under it.`);
  if (!kinds.includes(row.kind)) {
    throw ApiError.unprocessable(`This round is a "${row.kind}" round; this action needs one of: ${kinds.join(', ')}.`);
  }
  return row;
}

export interface ProposeConversionInput {
  /** The holder whose convertible holding is converting. */
  holderId: string;
  /** The convertible class — carries `conversionTerms` naming what it converts into and at what ratio. */
  fromClassId: string;
  /** How many units of the convertible class are converting. */
  count: number;
  effectiveOn: string;
  roundId?: string | null;
}

/**
 * A `ShareTransaction` of type `conversion`, from the convertible class to
 * its `conversionTerms.convertsToClassId` at `conversionTerms.ratio` — the
 * source holding is cancelled and the target allotted when this goes
 * effective (`makeEffective` in `equity.ts`), through the same
 * propose → approve → effective path every other ledger entry takes.
 */
export async function proposeConversion(input: ProposeConversionInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'share_ledger', verb: 'create' });

  if (input.count <= 0) throw ApiError.badRequest('A conversion must be for a positive number of shares.');

  const fromClass = await prisma.shareClass.findFirst({ where: { id: input.fromClassId, tenantId: auth.tenantId } });
  if (!fromClass) throw ApiError.notFound('Share class');
  const terms = (fromClass.conversionTerms ?? null) as ConversionTerms | null;
  if (!terms?.convertsToClassId || !terms.ratio) {
    throw ApiError.unprocessable(`${fromClass.name} carries no conversion terms — there is nothing to convert it into.`);
  }
  const toClass = await prisma.shareClass.findFirst({ where: { id: terms.convertsToClassId, tenantId: auth.tenantId } });
  if (!toClass) throw ApiError.notFound('The class this converts into');

  const holder = await prisma.holder.findFirst({ where: { id: input.holderId, tenantId: auth.tenantId } });
  if (!holder) throw ApiError.notFound('Holder');

  const balance = await effectiveBalance(input.holderId, input.fromClassId);
  if (balance < input.count) {
    throw ApiError.unprocessable(
      `This holder's effective balance in ${fromClass.name} is ${balance} shares, below the ${input.count} converting.`,
    );
  }

  const targetCount = Math.round(input.count * terms.ratio);
  if (targetCount <= 0) {
    throw ApiError.unprocessable('The conversion ratio applied to this count rounds to zero target shares.');
  }

  const row = await prisma.shareTransaction.create({
    data: {
      tenantId: auth.tenantId,
      recordCode: await nextRecordCode('SHT'),
      type: 'conversion',
      shareClassId: terms.convertsToClassId,
      fromShareClassId: input.fromClassId,
      fromHolderId: input.holderId,
      toHolderId: input.holderId,
      count: dec(targetCount)!,
      effectiveOn: new Date(input.effectiveOn),
      roundId: input.roundId ?? null,
      status: 'proposed',
      proposedByPartyId: auth.partyId ?? 'system',
      meta: { sourceCount: input.count, ratio: terms.ratio } as never,
    },
  });

  await auditWrite({ action: 'create', subjectType: 'share_transaction', subjectId: row.id, after: row as never });
  await emit({
    name: EVENTS.CONVERSION_PROPOSED,
    subject: { entityType: 'share_transaction', entityId: row.id, recordCode: row.recordCode },
    newState: { fromShareClassId: input.fromClassId, toShareClassId: terms.convertsToClassId, sourceCount: input.count, targetCount },
  });

  return shareTransactionView(row);
}

export interface ProposeRedemptionInput {
  holderId: string;
  shareClassId: string;
  count: number;
  effectiveOn: string;
  fromReserves: boolean;
  roundId?: string | null;
}

/** A `ShareTransaction` of type `redemption`, retiring the holding — RPS/NCD. */
export async function proposeRedemption(input: ProposeRedemptionInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'share_ledger', verb: 'create' });

  if (input.count <= 0) throw ApiError.badRequest('A redemption must be for a positive number of shares.');

  const shareClass = await prisma.shareClass.findFirst({ where: { id: input.shareClassId, tenantId: auth.tenantId } });
  if (!shareClass) throw ApiError.notFound('Share class');
  const holder = await prisma.holder.findFirst({ where: { id: input.holderId, tenantId: auth.tenantId } });
  if (!holder) throw ApiError.notFound('Holder');

  const balance = await effectiveBalance(input.holderId, input.shareClassId);
  if (balance < input.count) {
    throw ApiError.unprocessable(`This holder's effective balance in ${shareClass.name} is ${balance} shares, below the ${input.count} redeeming.`);
  }

  if (input.fromReserves) {
    const reserves = await freeReservesProxy();
    if (!reserves.measured) {
      throw ApiError.unprocessable(`A redemption funded from reserves needs reserves to be measurable. ${reserves.basis}`);
    }
    if (reserves.amount < input.count * (num(shareClass.faceValue) ?? 0)) {
      throw ApiError.unprocessable(
        `Measured free reserves (${reserves.amount}) do not cover the face value of the shares being redeemed from them.`,
      );
    }
  }

  const row = await prisma.shareTransaction.create({
    data: {
      tenantId: auth.tenantId,
      recordCode: await nextRecordCode('SHT'),
      type: 'redemption',
      shareClassId: input.shareClassId,
      fromHolderId: input.holderId,
      count: dec(input.count)!,
      effectiveOn: new Date(input.effectiveOn),
      roundId: input.roundId ?? null,
      status: 'proposed',
      proposedByPartyId: auth.partyId ?? 'system',
      meta: { fromReserves: input.fromReserves } as never,
    },
  });

  await auditWrite({ action: 'create', subjectType: 'share_transaction', subjectId: row.id, after: row as never });
  await emit({
    name: EVENTS.REDEMPTION_PROPOSED,
    subject: { entityType: 'share_transaction', entityId: row.id, recordCode: row.recordCode },
    newState: { shareClassId: input.shareClassId, holderId: input.holderId, count: input.count, fromReserves: input.fromReserves },
  });

  return shareTransactionView(row);
}

export interface ProposeBuybackInput {
  roundId: string;
  holderId: string;
  shareClassId: string;
  count: number;
  pricePerShare: number;
  effectiveOn: string;
}

/**
 * A `ShareTransaction` of type `buyback` under an open `buyback` round. The
 * s.68 ceilings are checked here at proposal time against what this buy-back
 * would take the company to — the board ceiling (≤10%), the special
 * resolution requirement above it and up to 25%, and the debt-equity test —
 * each refused by name, never silently clamped.
 */
export async function proposeBuyback(input: ProposeBuybackInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'share_ledger', verb: 'create' });

  if (input.count <= 0) throw ApiError.badRequest('A buy-back must be for a positive number of shares.');

  const roundRow = await requireOpenRoundOfKind(input.roundId, ['buyback']);

  const shareClass = await prisma.shareClass.findFirst({ where: { id: input.shareClassId, tenantId: auth.tenantId } });
  if (!shareClass) throw ApiError.notFound('Share class');
  const holder = await prisma.holder.findFirst({ where: { id: input.holderId, tenantId: auth.tenantId } });
  if (!holder) throw ApiError.notFound('Holder');

  const balance = await effectiveBalance(input.holderId, input.shareClassId);
  if (balance < input.count) {
    throw ApiError.unprocessable(`This holder's effective balance in ${shareClass.name} is ${balance} shares, below the ${input.count} being bought back.`);
  }

  const tests = await buybackTests();
  if (!tests.freeReserves.measured) {
    throw ApiError.unprocessable(`s.68 needs free reserves to be measurable before a buy-back may be proposed. ${tests.freeReserves.basis}`);
  }

  const value = round2(input.count * input.pricePerShare);
  if (tests.boardCeiling != null && value > tests.boardCeiling) {
    if (!roundRow.shareholderResolutionRef) {
      if (tests.specialResolutionCeiling != null && value > tests.specialResolutionCeiling) {
        throw ApiError.unprocessable(
          `s.68 caps a buy-back at 25% of paid-up capital and free reserves (${tests.specialResolutionCeiling}) even with a special resolution; ` +
            `this buy-back is worth ${value}.`,
        );
      }
      throw ApiError.unprocessable(
        `s.68 allows a buy-back above 10% of paid-up capital and free reserves (${tests.boardCeiling}) only with a shareholder special resolution, ` +
          `which this round does not carry (no shareholderResolutionRef). This buy-back is worth ${value}.`,
      );
    }
    if (tests.specialResolutionCeiling != null && value > tests.specialResolutionCeiling) {
      throw ApiError.unprocessable(
        `s.68 caps a buy-back at 25% of paid-up capital and free reserves (${tests.specialResolutionCeiling}) even with a special resolution; ` +
          `this buy-back is worth ${value}.`,
      );
    }
  }

  if (tests.debtEquityRatio != null && tests.debtEquityRatio > 2) {
    throw ApiError.unprocessable(
      `s.68 refuses a buy-back once debt-to-equity exceeds 2:1; it is currently ${tests.debtEquityRatio}:1.`,
    );
  }

  const row = await prisma.shareTransaction.create({
    data: {
      tenantId: auth.tenantId,
      recordCode: await nextRecordCode('SHT'),
      type: 'buyback',
      shareClassId: input.shareClassId,
      fromHolderId: input.holderId,
      count: dec(input.count)!,
      pricePerShare: dec(input.pricePerShare),
      effectiveOn: new Date(input.effectiveOn),
      roundId: input.roundId,
      status: 'proposed',
      proposedByPartyId: auth.partyId ?? 'system',
    },
  });

  await auditWrite({ action: 'create', subjectType: 'share_transaction', subjectId: row.id, after: row as never });
  await emit({
    name: EVENTS.BUYBACK_PROPOSED,
    subject: { entityType: 'share_transaction', entityId: row.id, recordCode: row.recordCode },
    newState: { shareClassId: input.shareClassId, holderId: input.holderId, count: input.count, value },
  });

  return shareTransactionView(row);
}

export interface ProposeBonusInput {
  roundId: string;
  shareClassId: string;
  ratioNumerator: number;
  ratioDenominator: number;
  effectiveOn: string;
}

/**
 * One proposal per current holder of the class, pro-rata at
 * `ratioNumerator`:`ratioDenominator` (a "1 for 2" bonus is `{1, 2}`) — s.63.
 * The round must already carry a measured, positive `sourceOfBonus` (checked
 * at `openRound`, re-checked here in case reserves moved since).
 */
export async function proposeBonus(input: ProposeBonusInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'share_ledger', verb: 'create' });

  if (input.ratioNumerator <= 0 || input.ratioDenominator <= 0) {
    throw ApiError.badRequest('A bonus ratio must be two positive numbers.');
  }

  const roundRow = await requireOpenRoundOfKind(input.roundId, ['bonus']);
  if (!roundRow.sourceOfBonus) {
    throw ApiError.unprocessable('s.63 needs this round to name a source of bonus before shares may be proposed under it.');
  }
  if (roundRow.sourceOfBonus === 'free_reserves') {
    const reserves = await freeReservesProxy();
    if (!reserves.measured || reserves.amount <= 0) {
      throw ApiError.unprocessable(
        reserves.measured
          ? `s.63 requires free reserves to exist before a bonus is declared from them. Measured cumulative retained profit is ${reserves.amount}, which is not positive.`
          : `s.63 requires free reserves to exist before a bonus is declared from them. ${reserves.basis}`,
      );
    }
  }

  const shareClass = await prisma.shareClass.findFirst({ where: { id: input.shareClassId, tenantId: auth.tenantId } });
  if (!shareClass) throw ApiError.notFound('Share class');

  const holders = await prisma.holder.findMany({ where: { tenantId: auth.tenantId, deletedAt: null } });
  const proposals: Array<ReturnType<typeof shareTransactionView>> = [];
  for (const holder of holders) {
    const balance = await effectiveBalance(holder.id, input.shareClassId);
    if (balance <= 0) continue;
    const bonusCount = Math.round((balance * input.ratioNumerator) / input.ratioDenominator);
    if (bonusCount <= 0) continue;

    const row = await prisma.shareTransaction.create({
      data: {
        tenantId: auth.tenantId,
        recordCode: await nextRecordCode('SHT'),
        type: 'bonus',
        shareClassId: input.shareClassId,
        toHolderId: holder.id,
        count: dec(bonusCount)!,
        effectiveOn: new Date(input.effectiveOn),
        roundId: input.roundId,
        status: 'proposed',
        proposedByPartyId: auth.partyId ?? 'system',
        meta: { ratioNumerator: input.ratioNumerator, ratioDenominator: input.ratioDenominator } as never,
      },
    });

    await auditWrite({ action: 'create', subjectType: 'share_transaction', subjectId: row.id, after: row as never });
    await emit({
      name: EVENTS.BONUS_PROPOSED,
      subject: { entityType: 'share_transaction', entityId: row.id, recordCode: row.recordCode },
      newState: { holderId: holder.id, shareClassId: input.shareClassId, count: bonusCount },
    });

    proposals.push(shareTransactionView(row));
  }

  return { items: proposals };
}

// ---------------------------------------------------------------------------
// Rights issue (s.62(1)(a)) — offer, acceptance, renunciation.
//
// Kept as entries on the round itself (`rightsEntitlements` inside
// `notes`-adjacent storage would be the wrong place; instead each offer is
// held as a lightweight row on `pricePerShareByClass`'s sibling structure)
// rather than a new table: the round already carries the statutory record,
// and an offer is small, per-holder, and never referenced outside this
// round.
// ---------------------------------------------------------------------------

interface RightsOffer {
  offerId: string;
  holderId: string;
  shareClassId: string;
  entitlement: number;
  accepted: number;
  renouncedToHolderId: string | null;
  status: 'offered' | 'accepted' | 'renounced' | 'lapsed';
}

async function loadRightsOffers(roundId: string): Promise<RightsOffer[]> {
  const auth = currentAuth();
  const row = await prisma.fundingRound.findFirst({ where: { id: roundId, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Round');
  const meta = (row.pricePerShareByClass as { __rightsOffers?: RightsOffer[] } | null) ?? {};
  return meta.__rightsOffers ?? [];
}

async function saveRightsOffers(roundId: string, offers: RightsOffer[]): Promise<void> {
  const auth = currentAuth();
  const row = await prisma.fundingRound.findFirst({ where: { id: roundId, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Round');
  const existing = (row.pricePerShareByClass as Record<string, unknown> | null) ?? {};
  await prisma.fundingRound.update({
    where: { id: roundId },
    data: { pricePerShareByClass: { ...existing, __rightsOffers: offers } as never },
  });
}

export interface CreateRightsOffersInput {
  roundId: string;
  shareClassId: string;
  /** Entitlement per holder as a ratio of their current holding — `{1, 4}` is "one new share for every four held". */
  ratioNumerator: number;
  ratioDenominator: number;
}

/** One offer per current holder of the class, entitlement at the stated ratio — s.62(1)(a). */
export async function createRightsOffers(input: CreateRightsOffersInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'share_ledger', verb: 'create' });

  await requireOpenRoundOfKind(input.roundId, ['rights_issue']);

  const holders = await prisma.holder.findMany({ where: { tenantId: auth.tenantId, deletedAt: null } });
  const offers: RightsOffer[] = [];
  for (const holder of holders) {
    const balance = await effectiveBalance(holder.id, input.shareClassId);
    if (balance <= 0) continue;
    const entitlement = Math.round((balance * input.ratioNumerator) / input.ratioDenominator);
    if (entitlement <= 0) continue;
    const offer: RightsOffer = {
      offerId: `${holder.id}:${input.shareClassId}:${Date.now()}`,
      holderId: holder.id,
      shareClassId: input.shareClassId,
      entitlement,
      accepted: 0,
      renouncedToHolderId: null,
      status: 'offered',
    };
    offers.push(offer);
    await emit({
      name: EVENTS.RIGHTS_OFFERED,
      subject: { entityType: 'funding_round', entityId: input.roundId },
      newState: { holderId: holder.id, shareClassId: input.shareClassId, entitlement },
    });
  }

  const existing = await loadRightsOffers(input.roundId);
  await saveRightsOffers(input.roundId, [...existing, ...offers]);
  return { items: offers };
}

export async function listRightsOffers(roundId: string) {
  await assertCan({ resource: 'rounds', verb: 'view' });
  return { items: await loadRightsOffers(roundId) };
}

/** Accepting an entitlement (in full or part) proposes the allotment on the round. */
export async function acceptRightsOffer(roundId: string, offerId: string, count: number) {
  const auth = currentAuth();
  await assertCan({ resource: 'share_ledger', verb: 'create' });

  const offers = await loadRightsOffers(roundId);
  const offer = offers.find((o) => o.offerId === offerId);
  if (!offer) throw ApiError.notFound('Rights offer');
  if (offer.status === 'renounced') throw ApiError.conflict('This entitlement has been renounced and cannot also be accepted.');
  const remaining = offer.entitlement - offer.accepted;
  if (count <= 0 || count > remaining) {
    throw ApiError.unprocessable(`Only ${remaining} shares remain of this entitlement.`);
  }

  const row = await prisma.shareTransaction.create({
    data: {
      tenantId: auth.tenantId,
      recordCode: await nextRecordCode('SHT'),
      type: 'allotment',
      shareClassId: offer.shareClassId,
      toHolderId: offer.holderId,
      count: dec(count)!,
      effectiveOn: new Date(),
      roundId,
      status: 'proposed',
      proposedByPartyId: auth.partyId ?? 'system',
      meta: { rightsOfferId: offerId } as never,
    },
  });

  offer.accepted += count;
  offer.status = offer.accepted >= offer.entitlement ? 'accepted' : 'offered';
  await saveRightsOffers(roundId, offers);

  await auditWrite({ action: 'create', subjectType: 'share_transaction', subjectId: row.id, after: row as never });
  await emit({
    name: EVENTS.RIGHTS_ACCEPTED,
    subject: { entityType: 'funding_round', entityId: roundId },
    newState: { offerId, count, shareTransactionId: row.id },
  });

  return { offer, allotment: shareTransactionView(row) };
}

/** Renouncing an entitlement to a named holder — allowed only when the round records `renunciationAllowed`. */
export async function renounceRightsOffer(roundId: string, offerId: string, toHolderId: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'share_ledger', verb: 'create' });

  const roundRow = await prisma.fundingRound.findFirst({ where: { id: roundId, tenantId: auth.tenantId } });
  if (!roundRow) throw ApiError.notFound('Round');
  if (!roundRow.renunciationAllowed) {
    throw ApiError.unprocessable('This rights round does not permit renunciation (renunciationAllowed is not set).');
  }

  const toHolder = await prisma.holder.findFirst({ where: { id: toHolderId, tenantId: auth.tenantId } });
  if (!toHolder) throw ApiError.notFound('Holder');

  const offers = await loadRightsOffers(roundId);
  const offer = offers.find((o) => o.offerId === offerId);
  if (!offer) throw ApiError.notFound('Rights offer');
  if (offer.accepted > 0) throw ApiError.conflict('Part of this entitlement has already been accepted and cannot also be renounced.');

  offer.status = 'renounced';
  offer.renouncedToHolderId = toHolderId;
  await saveRightsOffers(roundId, offers);

  await emit({
    name: EVENTS.RIGHTS_RENOUNCED,
    subject: { entityType: 'funding_round', entityId: roundId },
    newState: { offerId, renouncedToHolderId: toHolderId },
  });

  return { offer };
}

// ---------------------------------------------------------------------------
// Scenarios — pure, never persisted (EQT-RND-008). Reads the live cap table,
// hands it to `@kaizen/shared`'s pure functions, returns the result. No
// write happens anywhere in either function.
// ---------------------------------------------------------------------------

async function liveScenarioCapTable(): Promise<ScenarioCapTableRow[]> {
  const auth = currentAuth();
  const [transactions, classes, holders] = await Promise.all([
    prisma.shareTransaction.findMany({ where: { tenantId: auth.tenantId, status: 'effective' } }),
    prisma.shareClass.findMany({ where: { tenantId: auth.tenantId } }),
    prisma.holder.findMany({ where: { tenantId: auth.tenantId } }),
  ]);
  const classById = new Map(classes.map((c) => [c.id, c]));

  const net = new Map<string, number>();
  for (const t of transactions) {
    const amount = num(t.count) ?? 0;
    const outClassId = t.type === 'conversion' && t.fromShareClassId ? t.fromShareClassId : t.shareClassId;
    if (t.toHolderId) {
      const k = `${t.toHolderId}::${t.shareClassId}`;
      net.set(k, (net.get(k) ?? 0) + amount);
    }
    if (t.fromHolderId) {
      const k = `${t.fromHolderId}::${outClassId}`;
      net.set(k, (net.get(k) ?? 0) - outgoingCount(t));
    }
  }

  const rows: ScenarioCapTableRow[] = [];
  for (const [key, count] of net) {
    if (count <= 0) continue;
    const [holderId, shareClassId] = key.split('::');
    const cls = classById.get(shareClassId);
    const holder = holders.find((h) => h.id === holderId);
    const rights = (cls?.rights ?? {}) as { liquidationPreference?: { multiple: number; participating: boolean; seniority: number } };
    rows.push({
      holderId,
      holderName: holder ? holder.folioNumber : holderId,
      shareClassId,
      preference: rights.liquidationPreference ?? null,
      count,
    });
  }
  return rows;
}

export async function scenarioRound(input: ModelRoundInput) {
  await assertCan({ resource: 'cap_table', verb: 'view' });
  const capTableRows = await liveScenarioCapTable();
  return modelRound(capTableRows, input);
}

export async function scenarioWaterfall(exitValue: number) {
  await assertCan({ resource: 'cap_table', verb: 'view' });
  const capTableRows = await liveScenarioCapTable();

  const auth = currentAuth();
  const classes = await prisma.shareClass.findMany({ where: { tenantId: auth.tenantId } });
  const priceByClass: Record<string, number> = {};
  for (const c of classes) priceByClass[c.id] = num(c.faceValue) ?? 0;

  return waterfall(capTableRows, priceByClass, exitValue);
}
