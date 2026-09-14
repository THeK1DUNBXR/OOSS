/**
 * Statutory exports, demat (Rule 9B) and FEMA — equity-portal plan §6 phase
 * 6a.
 *
 * Three unrelated statutory jobs share one file because they share one
 * mechanism: an event or a scheduled sweep raises an `ExceptionRecord`
 * naming the form and the deadline, and `recordFiling` closes it — there is
 * no second calendar here, only the register's own exception engine (§3.6)
 * fed a few more triggers, and the two guard checks (`assertDematCompliant`,
 * `assertFemaPricingFloor`) `equity.ts` calls before a proposal is even
 * written.
 *
 * Group-dependent exports — AOC-1, BEN-2 — are not here; they read the
 * holding tenant's own `EntitySnapshot` rows and belong to the phase that
 * owns the group screen.
 */

import * as XLSX from 'xlsx';
import {
  EVENTS,
  FILING_FORMS,
  type FilingForm,
  type FilingStatus,
  type FilingView,
  type Mgt1Row,
  type Pas3Row,
  type Pas6ClassFigure,
  type Pas6View,
  type Sh4Data,
} from '@kaizen/shared';
import { prisma, num } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { assertCan } from '../platform/permissions.js';
import { ApiError } from '../platform/errors.js';
import { auditWrite, registerGovernedEntities } from '../platform/audit.js';
import { emit } from '../platform/eventBus.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { raiseException, resolveException } from '../platform/exceptions.js';
import { companyProfile } from './companyProfile.js';
import { effectiveBalance, holderView, outgoingCount } from './equity.js';

registerGovernedEntities('eqt', ['filing']);

// ---------------------------------------------------------------------------
// Demat (Rule 9B) — the guard called from `equity.ts` before a proposal is
// written, not after.
// ---------------------------------------------------------------------------

/**
 * Refuses an allotment or a transfer that names a holder without a demat
 * account, when the company issues and transfers in demat form only.
 *
 * Called for every holder on the transaction's *receiving* side — the side
 * whose holding is actually being created or moved — a `mixed` company is
 * left to the register keeper's judgement (some classes may still be
 * physical), so only `dematStatus === 'demat'` (fully) triggers the refusal.
 */
export async function assertDematCompliant(holderIds: Array<string | null | undefined>): Promise<void> {
  const auth = currentAuth();
  const profile = await companyProfile();
  if (profile.dematStatus !== 'demat') return;

  for (const holderId of holderIds) {
    if (!holderId) continue;
    const holder = await prisma.holder.findFirst({ where: { id: holderId, tenantId: auth.tenantId } });
    if (!holder) continue; // a missing holder is `equity.ts`'s own 404 to raise, not this guard's
    if (!holder.dematAccount) {
      const view = await holderView(holder);
      throw ApiError.unprocessable(
        "Rule 9B: this company issues and transfers securities in demat form only; record the holder's demat " +
          `account first (${view.displayName}, folio ${view.folioNumber}).`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// FEMA — the pricing floor, checked at the same point.
// ---------------------------------------------------------------------------

function isRepatriableNonResident(holder: { residency: string; investmentBasis: string | null }): boolean {
  return holder.residency === 'non_resident' && holder.investmentBasis === 'repatriable';
}

/**
 * FEMA's fair-value floor: an issue or transfer to a repatriable non-resident
 * may not price below the latest valuation's per-share figure for the class.
 *
 * Refuses below the floor. With no valuation on record at all, this allows
 * the proposal through but raises `EX-EQT-009` once and returns a note the
 * caller folds into the response (`femaPricingNote`) rather than silently
 * approving an unpriced issue to a foreign holder.
 *
 * `toHolderId` is the holder the shares land with — the only side FEMA's
 * pricing rule reaches, on both an allotment and a transfer.
 */
export async function assertFemaPricingFloor(input: {
  toHolderId: string;
  shareClassId: string;
  pricePerShare: number | null | undefined;
}): Promise<{ femaPricingNote: string | null }> {
  const auth = currentAuth();
  const toHolder = await prisma.holder.findFirst({ where: { id: input.toHolderId, tenantId: auth.tenantId } });
  if (!toHolder || !isRepatriableNonResident(toHolder)) return { femaPricingNote: null };
  if (input.pricePerShare == null) return { femaPricingNote: null };

  const valuation = await prisma.valuation.findFirst({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      basis: { in: ['registered_valuer', 'merchant_banker', 'ca_certificate'] },
    },
    orderBy: { asOf: 'desc' },
  });

  const perShareByClass = (valuation?.perShareByClass ?? {}) as Record<string, number>;
  const floor = valuation ? perShareByClass[input.shareClassId] : undefined;

  if (valuation && floor != null) {
    if (input.pricePerShare < floor) {
      throw ApiError.unprocessable(
        `FEMA pricing: an issue or transfer to a non-resident may not be below fair value (₹${floor} per share on ` +
          `${valuation.asOf.toISOString().slice(0, 10)}).`,
      );
    }
    return { femaPricingNote: null };
  }

  await raiseException({
    code: 'EX-EQT-009',
    label: 'FEMA fair-value certificate missing',
    severity: 'S2_WARNING',
    subjectType: 'holder',
    subjectId: toHolder.id,
    subjectLabel: (await holderView(toHolder)).displayName,
    domain: 'eqt',
    detail:
      'NDI Rules: an issue or transfer to a repatriable non-resident must price at or above fair value, certified by ' +
      'a registered valuer, a merchant banker or a chartered accountant. No such certificate is on record, so the ' +
      'price entered here could not be checked against the floor.',
    reasonCode: 'fema_valuation_missing',
    triggerFingerprint: `fema_valuation_missing:${toHolder.id}`,
  });

  return { femaPricingNote: 'No fair-value certificate on record' };
}

// ---------------------------------------------------------------------------
// FEMA — the calendar, subscribed from `events/handlers.ts` against the
// register's own effective events.
// ---------------------------------------------------------------------------

/** `kz.eqt.allotment.effective` — FC-GPR within 30 days for a repatriable non-resident allottee. Schedule IV holders (non-repatriable) raise nothing. */
export async function handleAllotmentEffectiveForFema(transactionId: string): Promise<void> {
  const auth = currentAuth();
  const txn = await prisma.shareTransaction.findFirst({ where: { id: transactionId, tenantId: auth.tenantId } });
  if (!txn || !txn.toHolderId) return;
  const toHolder = await prisma.holder.findFirst({ where: { id: txn.toHolderId, tenantId: auth.tenantId } });
  if (!toHolder || !isRepatriableNonResident(toHolder)) return;

  const dueOn = new Date(txn.effectiveOn.getTime() + 30 * 86_400_000);
  await raiseException({
    code: 'EX-EQT-006',
    label: 'FC-GPR due (allotment to a non-resident)',
    severity: 'S2_WARNING',
    subjectType: 'share_transaction',
    subjectId: txn.id,
    subjectLabel: txn.recordCode,
    domain: 'eqt',
    detail:
      `NDI Rules: an allotment to a repatriable non-resident needs an FC-GPR filing within 30 days. ${txn.recordCode} ` +
      `went effective on ${txn.effectiveOn.toISOString().slice(0, 10)}; FC-GPR is due by ${dueOn.toISOString().slice(0, 10)}.`,
    reasonCode: 'fc_gpr_due',
    slaDueAt: dueOn,
    triggerFingerprint: `fc_gpr_due:${txn.id}`,
  });
}

/** `kz.eqt.transfer.effective` — FC-TRS within 60 days when one side of the transfer is a repatriable non-resident and the other resident. */
export async function handleTransferEffectiveForFema(transactionId: string): Promise<void> {
  const auth = currentAuth();
  const txn = await prisma.shareTransaction.findFirst({ where: { id: transactionId, tenantId: auth.tenantId } });
  if (!txn || !txn.toHolderId || !txn.fromHolderId) return;

  const [toHolder, fromHolder] = await Promise.all([
    prisma.holder.findFirst({ where: { id: txn.toHolderId, tenantId: auth.tenantId } }),
    prisma.holder.findFirst({ where: { id: txn.fromHolderId, tenantId: auth.tenantId } }),
  ]);
  if (!toHolder || !fromHolder) return;

  const toIsRepatriableNr = isRepatriableNonResident(toHolder);
  const fromIsRepatriableNr = isRepatriableNonResident(fromHolder);
  const crossesResidency =
    (toIsRepatriableNr && fromHolder.residency === 'resident') ||
    (fromIsRepatriableNr && toHolder.residency === 'resident');
  if (!crossesResidency) return;

  const dueOn = new Date(txn.effectiveOn.getTime() + 60 * 86_400_000);
  await raiseException({
    code: 'EX-EQT-007',
    label: 'FC-TRS due (transfer to/from a non-resident)',
    severity: 'S2_WARNING',
    subjectType: 'share_transaction',
    subjectId: txn.id,
    subjectLabel: txn.recordCode,
    domain: 'eqt',
    detail:
      `NDI Rules: a transfer between a repatriable non-resident and a resident needs an FC-TRS filing within 60 ` +
      `days. ${txn.recordCode} went effective on ${txn.effectiveOn.toISOString().slice(0, 10)}; FC-TRS is due by ` +
      `${dueOn.toISOString().slice(0, 10)}.`,
    reasonCode: 'fc_trs_due',
    slaDueAt: dueOn,
    triggerFingerprint: `fc_trs_due:${txn.id}`,
  });
}

/**
 * The yearly FLA sweep (jobs/scheduler.ts): raises `EX-EQT-008`, due 15 July,
 * once per financial year, whenever a repatriable non-resident holds
 * anything effective as of the most recently completed 31 March. A holder
 * whose holding has since gone to zero raises nothing that year.
 */
export async function runFlaReturn(): Promise<number> {
  const auth = currentAuth();
  const now = new Date();
  // The most recently completed 31 March: this year's if we are already past
  // it, last year's otherwise.
  const marchThisYear = new Date(Date.UTC(now.getUTCFullYear(), 2, 31, 23, 59, 59));
  const cutoff = now >= marchThisYear ? marchThisYear : new Date(Date.UTC(now.getUTCFullYear() - 1, 2, 31, 23, 59, 59));
  const flaYear = cutoff.getUTCFullYear();

  const holders = await prisma.holder.findMany({
    where: { tenantId: auth.tenantId, residency: 'non_resident', investmentBasis: 'repatriable', deletedAt: null },
  });
  if (holders.length === 0) return 0;

  const classes = await prisma.shareClass.findMany({ where: { tenantId: auth.tenantId } });

  let raised = 0;
  for (const holder of holders) {
    let anyHolding = false;
    for (const cls of classes) {
      const balance = await effectiveBalanceAsOf(holder.id, cls.id, cutoff);
      if (balance > 0) {
        anyHolding = true;
        break;
      }
    }
    if (!anyHolding) continue;

    const dueOn = new Date(Date.UTC(flaYear + 1, 6, 15));
    await raiseException({
      code: 'EX-EQT-008',
      label: 'FLA return due',
      severity: 'S2_WARNING',
      subjectType: 'holder',
      subjectId: holder.id,
      subjectLabel: holder.folioNumber,
      domain: 'eqt',
      detail:
        `A repatriable non-resident holding existed on 31 March ${flaYear}, so an FLA return is due by 15 July ` +
        `${flaYear + 1}.`,
      reasonCode: 'fla_due',
      slaDueAt: dueOn,
      triggerFingerprint: `fla_due:${flaYear}:${holder.id}`,
    });
    raised += 1;
  }
  return raised;
}

/** `effectiveBalance` as of a cutoff date, for the FLA sweep — the same netting, restricted to transactions effective on or before `asOf`. */
async function effectiveBalanceAsOf(holderId: string, shareClassId: string, asOf: Date): Promise<number> {
  const auth = currentAuth();
  const [intoRows, outRows] = await Promise.all([
    prisma.shareTransaction.findMany({
      where: { tenantId: auth.tenantId, shareClassId, toHolderId: holderId, status: 'effective', effectiveOn: { lte: asOf } },
      select: { count: true },
    }),
    prisma.shareTransaction.findMany({
      where: {
        tenantId: auth.tenantId,
        fromHolderId: holderId,
        status: 'effective',
        effectiveOn: { lte: asOf },
        OR: [{ shareClassId, type: { not: 'conversion' } }, { fromShareClassId: shareClassId, type: 'conversion' }],
      },
      select: { count: true, type: true, meta: true },
    }),
  ]);
  const into = intoRows.reduce((s, r) => s + (num(r.count) ?? 0), 0);
  const outOf = outRows.reduce((s, r) => s + outgoingCount(r), 0);
  return into - outOf;
}

// ---------------------------------------------------------------------------
// Demat (Rule 9B) — the periodic checks (jobs/scheduler.ts).
// ---------------------------------------------------------------------------

/**
 * `EX-EQT-004`: the register is still physical and this tenant is no longer
 * allowed one — either a stated non-small company, or (regardless of the
 * flag, per s.2(85)) a holding or a subsidiary.
 *
 * `EX-EQT-005`: the register carries demat or mixed holdings with no ISIN on
 * file — nothing can actually settle at a depository without one.
 */
export async function checkDematRequirements(): Promise<number> {
  const auth = currentAuth();
  const [profile, tenant] = await Promise.all([
    companyProfile(),
    prisma.tenant.findFirst({ where: { id: auth.tenantId }, select: { kind: true } }),
  ]);

  const isHoldingOrSubsidiary = tenant?.kind === 'holding' || tenant?.kind === 'subsidiary';
  const noLongerSmall = profile.isSmallCompany === false || isHoldingOrSubsidiary;

  let raised = 0;

  if (profile.dematStatus === 'physical' && noLongerSmall) {
    const secretary = await prisma.affiliation.findFirst({
      where: { tenantId: auth.tenantId, roleSlug: { in: ['company_secretary', 'chairman'] }, status: 'active' },
      orderBy: { primaryFlag: 'desc' },
    });
    await raiseException({
      code: 'EX-EQT-004',
      label: 'Dematerialisation required (Rule 9B)',
      severity: 'S2_WARNING',
      subjectType: 'company_profile',
      subjectId: profile.id,
      subjectLabel: 'Company profile',
      domain: 'eqt',
      detail:
        'Rule 9B (PAS Rules) requires a company that is no longer small — including any holding or subsidiary, ' +
        'regardless of size — to dematerialise its securities: an ISIN through NSDL or CDSL, a registrar, and no ' +
        'further physical issue or transfer. The register is still recorded as physical.',
      reasonCode: 'demat_required',
      ownerPartyId: secretary?.partyId ?? null,
      triggerFingerprint: 'demat_required',
    });
    raised += 1;
  }

  if ((profile.dematStatus === 'demat' || profile.dematStatus === 'mixed') && !profile.isin) {
    const secretary = await prisma.affiliation.findFirst({
      where: { tenantId: auth.tenantId, roleSlug: { in: ['company_secretary', 'chairman'] }, status: 'active' },
      orderBy: { primaryFlag: 'desc' },
    });
    await raiseException({
      code: 'EX-EQT-005',
      label: 'ISIN missing for a dematerialised register',
      severity: 'S2_WARNING',
      subjectType: 'company_profile',
      subjectId: profile.id,
      subjectLabel: 'Company profile',
      domain: 'eqt',
      detail: 'The register is recorded as demat or mixed, but no ISIN is on file — set it under Company details.',
      reasonCode: 'isin_missing',
      ownerPartyId: secretary?.partyId ?? null,
      triggerFingerprint: 'isin_missing',
    });
    raised += 1;
  }

  return raised;
}

/** The half-year boundary, 30 September and 31 March, most recently reached on or before `now`. */
function latestHalfYearEnd(now: Date): Date {
  const y = now.getUTCFullYear();
  const sep30 = new Date(Date.UTC(y, 8, 30, 23, 59, 59));
  const mar31 = new Date(Date.UTC(y, 2, 31, 23, 59, 59));
  const candidates = [
    new Date(Date.UTC(y - 1, 8, 30, 23, 59, 59)),
    mar31,
    sep30,
  ].filter((d) => d <= now);
  return candidates.reduce((latest, d) => (d > latest ? d : latest));
}

/** `EX-EQT-010`: the PAS-6 reconciliation item, due 60 days after each half-year end, raised once per half-year. */
export async function runPas6HalfYearly(): Promise<number> {
  const auth = currentAuth();
  const profile = await companyProfile();
  if (profile.dematStatus !== 'demat' && profile.dematStatus !== 'mixed') return 0;

  const periodEnd = latestHalfYearEnd(new Date());
  const dueOn = new Date(periodEnd.getTime() + 60 * 86_400_000);
  const secretary = await prisma.affiliation.findFirst({
    where: { tenantId: auth.tenantId, roleSlug: { in: ['company_secretary', 'chairman'] }, status: 'active' },
    orderBy: { primaryFlag: 'desc' },
  });

  await raiseException({
    code: 'EX-EQT-010',
    label: 'PAS-6 reconciliation due',
    severity: 'S2_WARNING',
    subjectType: 'company_profile',
    subjectId: profile.id,
    subjectLabel: 'Company profile',
    domain: 'eqt',
    detail:
      `Rule 9B: a PAS-6 reconciliation of share capital audit report is due within 60 days of each half-year end. ` +
      `The half-year ending ${periodEnd.toISOString().slice(0, 10)} is due by ${dueOn.toISOString().slice(0, 10)}.`,
    reasonCode: 'pas6_due',
    ownerPartyId: secretary?.partyId ?? null,
    slaDueAt: dueOn,
    triggerFingerprint: `pas6_due:${periodEnd.toISOString().slice(0, 10)}`,
  });
  return 1;
}

// ---------------------------------------------------------------------------
// PAS-6 figures
// ---------------------------------------------------------------------------

export async function pas6(): Promise<Pas6View> {
  const auth = currentAuth();
  await assertCan({ resource: 'compliance', verb: 'view' });

  const profile = await companyProfile();
  const classes = await prisma.shareClass.findMany({ where: { tenantId: auth.tenantId, kind: { in: ['equity', 'preference'] } } });
  const holders = await prisma.holder.findMany({ where: { tenantId: auth.tenantId, deletedAt: null } });

  const classes_: Pas6ClassFigure[] = [];
  for (const cls of classes) {
    let issued = 0;
    let demat = 0;
    let physical = 0;
    for (const h of holders) {
      const balance = await effectiveBalance(h.id, cls.id);
      if (balance <= 0) continue;
      issued += balance;
      if (h.dematAccount) demat += balance;
      else physical += balance;
    }
    classes_.push({
      shareClassId: cls.id,
      shareClassName: cls.name,
      issuedCount: issued,
      dematCount: demat,
      physicalCount: physical,
      difference: issued - (demat + physical),
    });
  }

  return { asOf: new Date().toISOString(), isin: profile.isin, dematStatus: profile.dematStatus as never, classes: classes_ };
}

// ---------------------------------------------------------------------------
// MGT-1 / MGT-2 — the register of members / debenture holders.
// ---------------------------------------------------------------------------

async function mgt1RowsForClass(shareClassId: string): Promise<Mgt1Row[]> {
  const auth = currentAuth();
  const transactions = await prisma.shareTransaction.findMany({
    where: { tenantId: auth.tenantId, shareClassId, status: 'effective' },
    orderBy: { effectiveOn: 'asc' },
  });

  const memberIds = new Set<string>();
  for (const t of transactions) {
    if (t.toHolderId) memberIds.add(t.toHolderId);
  }

  const rows: Mgt1Row[] = [];
  for (const holderId of memberIds) {
    const holder = await prisma.holder.findFirst({ where: { id: holderId, tenantId: auth.tenantId } });
    if (!holder) continue;
    const view = await holderView(holder);

    const becameMemberOn = transactions.find((t) => t.toHolderId === holderId)?.effectiveOn ?? null;
    const balance = await effectiveBalance(holderId, shareClassId);

    const lastOutgoing = [...transactions].reverse().find((t) => t.fromHolderId === holderId);
    const ceasedOn = balance <= 0 && lastOutgoing ? lastOutgoing.effectiveOn : null;

    const certs = balance > 0
      ? await prisma.shareCertificate.findMany({
          where: { tenantId: auth.tenantId, holderId, shareClassId, status: 'issued' },
          orderBy: { distinctiveFrom: 'asc' },
        })
      : [];

    const shareClass = await prisma.shareClass.findFirstOrThrow({ where: { id: shareClassId } });
    const faceValue = num(shareClass.faceValue);

    let email = '';
    if (holder.kind === 'person' && holder.personId) {
      const person = await prisma.person.findFirst({ where: { id: holder.personId }, select: { primaryEmail: true } });
      email = person?.primaryEmail ?? '';
    }

    rows.push({
      folioNumber: holder.folioNumber,
      holderName: view.displayName,
      address: holder.address ?? '',
      email,
      panOrCin: holder.panNumber ?? '',
      guardianOrSpouseName: holder.guardianOrSpouseName ?? '',
      occupation: holder.occupation ?? '',
      nationality: holder.nationality ?? (holder.residency === 'non_resident' ? 'Not recorded' : 'Indian'),
      becameMemberOn: becameMemberOn ? becameMemberOn.toISOString().slice(0, 10) : '',
      ceasedOn: ceasedOn ? ceasedOn.toISOString().slice(0, 10) : '',
      distinctiveNumbers: certs.map((c) => `${c.distinctiveFrom}-${c.distinctiveTo}`).join('; '),
      certificateNumbers: certs.map((c) => c.certificateNumber).join('; '),
      nominalValue: faceValue == null ? null : Math.round(faceValue * balance * 100) / 100,
      amountPaidUp: faceValue == null ? null : Math.round(faceValue * balance * 100) / 100,
      lockIn: '',
      remarks: '',
    });
  }

  return rows;
}

export async function mgt1Register(shareClassId?: string): Promise<Array<{ shareClass: { id: string; name: string }; rows: Mgt1Row[] }>> {
  const auth = currentAuth();
  await assertCan({ resource: 'compliance', verb: 'view' });

  const classes = await prisma.shareClass.findMany({
    where: {
      tenantId: auth.tenantId,
      kind: { in: ['equity', 'preference'] },
      ...(shareClassId ? { id: shareClassId } : {}),
    },
    orderBy: { createdAt: 'asc' },
  });

  const out: Array<{ shareClass: { id: string; name: string }; rows: Mgt1Row[] }> = [];
  for (const cls of classes) {
    out.push({ shareClass: { id: cls.id, name: cls.name }, rows: await mgt1RowsForClass(cls.id) });
  }
  return out;
}

export async function mgt2Register(): Promise<Array<{ shareClass: { id: string; name: string }; rows: Mgt1Row[] }>> {
  const auth = currentAuth();
  await assertCan({ resource: 'compliance', verb: 'view' });

  const classes = await prisma.shareClass.findMany({ where: { tenantId: auth.tenantId, kind: 'debenture' }, orderBy: { createdAt: 'asc' } });
  const out: Array<{ shareClass: { id: string; name: string }; rows: Mgt1Row[] }> = [];
  for (const cls of classes) {
    out.push({ shareClass: { id: cls.id, name: cls.name }, rows: await mgt1RowsForClass(cls.id) });
  }
  return out;
}

const MGT1_HEADER = [
  'Folio', 'Name', 'Address', 'Email', 'PAN / CIN', 'Father / spouse name', 'Occupation',
  'Nationality / residency', 'Date of becoming member', 'Date of cessation', 'Distinctive numbers held',
  'Certificate numbers', 'Nominal value', 'Amount paid up', 'Lock-in', 'Remarks',
];

function mgt1SheetRows(rows: Mgt1Row[]): unknown[][] {
  return rows.map((r) => [
    r.folioNumber, r.holderName, r.address, r.email, r.panOrCin, r.guardianOrSpouseName, r.occupation,
    r.nationality, r.becameMemberOn, r.ceasedOn, r.distinctiveNumbers, r.certificateNumbers,
    r.nominalValue, r.amountPaidUp, r.lockIn, r.remarks,
  ]);
}

export async function mgt1Export(shareClassId?: string): Promise<Buffer> {
  const groups = await mgt1Register(shareClassId);
  const book = XLSX.utils.book_new();
  if (groups.length === 0) {
    const sheet = XLSX.utils.aoa_to_sheet([MGT1_HEADER]);
    XLSX.utils.book_append_sheet(book, sheet, 'MGT-1');
  }
  for (const g of groups) {
    const sheet = XLSX.utils.aoa_to_sheet([MGT1_HEADER, ...mgt1SheetRows(g.rows)]);
    sheet['!cols'] = MGT1_HEADER.map((h) => ({ wch: Math.max(12, Math.min(30, h.length + 4)) }));
    // Sheet names are capped at 31 characters and cannot repeat or carry `/`.
    const name = g.shareClass.name.replace(/[/\\?*[\]:]/g, ' ').slice(0, 28) || 'Class';
    XLSX.utils.book_append_sheet(book, sheet, name);
  }
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

export async function mgt2Export(): Promise<Buffer> {
  const groups = await mgt2Register();
  const book = XLSX.utils.book_new();
  if (groups.length === 0) {
    const sheet = XLSX.utils.aoa_to_sheet([MGT1_HEADER]);
    XLSX.utils.book_append_sheet(book, sheet, 'MGT-2');
  }
  for (const g of groups) {
    const sheet = XLSX.utils.aoa_to_sheet([MGT1_HEADER, ...mgt1SheetRows(g.rows)]);
    sheet['!cols'] = MGT1_HEADER.map((h) => ({ wch: Math.max(12, Math.min(30, h.length + 4)) }));
    const name = g.shareClass.name.replace(/[/\\?*[\]:]/g, ' ').slice(0, 28) || 'Class';
    XLSX.utils.book_append_sheet(book, sheet, name);
  }
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

// ---------------------------------------------------------------------------
// PAS-3 — the allottee list for a round.
// ---------------------------------------------------------------------------

export async function pas3AllotteeList(roundId: string): Promise<{ round: Record<string, unknown>; rows: Pas3Row[] }> {
  const auth = currentAuth();
  await assertCan({ resource: 'compliance', verb: 'view' });

  const round = await prisma.fundingRound.findFirst({ where: { id: roundId, tenantId: auth.tenantId } });
  if (!round) throw ApiError.notFound('Round');

  const allotments = await prisma.shareTransaction.findMany({
    where: { tenantId: auth.tenantId, roundId, type: 'allotment', status: 'effective' },
    orderBy: { effectiveOn: 'asc' },
  });

  const rows: Pas3Row[] = [];
  for (const t of allotments) {
    if (!t.toHolderId) continue;
    const holder = await prisma.holder.findFirst({ where: { id: t.toHolderId } });
    if (!holder) continue;
    const view = await holderView(holder);
    const shareClass = await prisma.shareClass.findFirstOrThrow({ where: { id: t.shareClassId } });
    const faceValue = num(shareClass.faceValue) ?? 0;
    const count = num(t.count) ?? 0;
    const price = num(t.pricePerShare);
    const nominalValue = Math.round(faceValue * count * 100) / 100;
    const total = price == null ? null : Math.round(price * count * 100) / 100;
    const premium = price == null ? null : Math.round((price - faceValue) * count * 100) / 100;

    rows.push({
      holderName: view.displayName,
      address: holder.address ?? '',
      pan: holder.panNumber ?? '',
      nationality: holder.nationality ?? (holder.residency === 'non_resident' ? 'Not recorded' : 'Indian'),
      shareClassName: shareClass.name,
      count,
      nominalValue,
      premium,
      total,
      consideration: t.considerationTransactionId ? 'Cash' : 'Not recorded',
      effectiveOn: t.effectiveOn.toISOString().slice(0, 10),
    });
  }

  const preCapital = await capitalAsOf(round.openedOn ?? round.createdAt);
  const postCapital = await capitalAsOf(round.closedOn ?? new Date());

  return {
    round: {
      recordCode: round.recordCode,
      name: round.name,
      kind: round.kind,
      boardResolutionRef: round.boardResolutionRef,
      shareholderResolutionRef: round.shareholderResolutionRef,
      mgt14Srn: round.mgt14Srn,
      preCapital,
      postCapital,
    },
    rows,
  };
}

/** Total issued equity + preference nominal capital effective as of a date — the header block's pre/post figure. */
async function capitalAsOf(asOf: Date): Promise<number> {
  const auth = currentAuth();
  const classes = await prisma.shareClass.findMany({ where: { tenantId: auth.tenantId, kind: { in: ['equity', 'preference'] } } });
  const transactions = await prisma.shareTransaction.findMany({
    where: { tenantId: auth.tenantId, status: 'effective', effectiveOn: { lte: asOf } },
  });
  const classById = new Map(classes.map((c) => [c.id, c]));
  let total = 0;
  for (const t of transactions) {
    const cls = classById.get(t.shareClassId);
    if (!cls) continue;
    const faceValue = num(cls.faceValue) ?? 0;
    if (t.toHolderId) total += faceValue * (num(t.count) ?? 0);
    if (t.fromHolderId) total -= faceValue * outgoingCount(t);
  }
  return Math.round(total * 100) / 100;
}

export async function pas3Export(roundId: string): Promise<Buffer> {
  const { round, rows } = await pas3AllotteeList(roundId);
  const header = ['Name', 'Address', 'PAN', 'Nationality', 'Class', 'Count', 'Nominal value', 'Premium', 'Total', 'Consideration', 'Date'];
  const body = rows.map((r) => [
    r.holderName, r.address, r.pan, r.nationality, r.shareClassName, r.count, r.nominalValue, r.premium, r.total, r.consideration, r.effectiveOn,
  ]);
  const book = XLSX.utils.book_new();
  const headerBlock: unknown[][] = [
    ['PAS-3 — return of allotment'],
    ['Round', round.name as string],
    ['Kind', round.kind as string],
    ['Board resolution', (round.boardResolutionRef as string | null) ?? 'Not recorded'],
    ['Shareholder resolution', (round.shareholderResolutionRef as string | null) ?? 'Not recorded'],
    ['MGT-14 SRN', (round.mgt14Srn as string | null) ?? 'Not recorded'],
    ['Pre-round capital', round.preCapital as number],
    ['Post-round capital', round.postCapital as number],
    [],
    header,
  ];
  const sheet = XLSX.utils.aoa_to_sheet([...headerBlock, ...body]);
  sheet['!cols'] = header.map((h) => ({ wch: Math.max(12, Math.min(30, h.length + 4)) }));
  XLSX.utils.book_append_sheet(book, sheet, 'PAS-3');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

// ---------------------------------------------------------------------------
// SH-4 — the pre-fill for a transfer.
// ---------------------------------------------------------------------------

export async function sh4Data(transactionId: string): Promise<Sh4Data> {
  const auth = currentAuth();
  await assertCan({ resource: 'compliance', verb: 'view' });

  const txn = await prisma.shareTransaction.findFirst({ where: { id: transactionId, tenantId: auth.tenantId } });
  if (!txn) throw ApiError.notFound('Share transaction');
  if (txn.type !== 'transfer') throw ApiError.badRequest('SH-4 pre-fill applies to a transfer transaction only.');
  if (!txn.fromHolderId || !txn.toHolderId) throw ApiError.unprocessable('This transfer has no transferor or transferee on record.');

  const [profile, fromHolder, toHolder, shareClass] = await Promise.all([
    companyProfile(),
    prisma.holder.findFirstOrThrow({ where: { id: txn.fromHolderId } }),
    prisma.holder.findFirstOrThrow({ where: { id: txn.toHolderId } }),
    prisma.shareClass.findFirstOrThrow({ where: { id: txn.shareClassId } }),
  ]);
  const [fromView, toView] = await Promise.all([holderView(fromHolder), holderView(toHolder)]);

  const certs = txn.status === 'effective'
    ? await prisma.shareCertificate.findMany({ where: { tenantId: auth.tenantId, issuedForTransactionId: txn.id, holderId: toHolder.id } })
    : [];

  const count = num(txn.count) ?? 0;
  const price = num(txn.pricePerShare);
  const consideration = price == null ? null : Math.round(price * count * 100) / 100;

  // Whether this particular transfer moved shares held in demat form —
  // both parties' own `dematAccount`, not just the company's overall status,
  // since a `mixed` company can carry either kind of holding.
  const dematLeg = Boolean(fromHolder.dematAccount && toHolder.dematAccount);

  return {
    companyLegalName: profile.legalName,
    companyCin: profile.cin,
    transactionRecordCode: txn.recordCode,
    effectiveOn: txn.effectiveOn ? txn.effectiveOn.toISOString() : null,
    transferor: { name: fromView.displayName, folioNumber: fromView.folioNumber, address: fromHolder.address ?? null },
    transferee: { name: toView.displayName, folioNumber: toView.folioNumber, address: toHolder.address ?? null },
    shareClassName: shareClass.name,
    distinctiveFrom: txn.distinctiveFrom == null ? null : String(txn.distinctiveFrom),
    distinctiveTo: txn.distinctiveTo == null ? null : String(txn.distinctiveTo),
    count,
    certificateNumbers: certs.map((c) => c.certificateNumber),
    pricePerShare: price,
    consideration,
    dematLeg,
    stampDuty: dematLeg && consideration != null ? Math.round(consideration * 0.00015 * 100) / 100 : null,
    stampDutyNote: dematLeg ? null : 'State stamp rate not recorded',
  };
}

// ---------------------------------------------------------------------------
// The filing log.
// ---------------------------------------------------------------------------

/** The exception this form's status closes, when one is raised for it — resolved by code and the same subject the exception was raised against. */
const FORM_EXCEPTION: Partial<Record<FilingForm, { code: string; subjectType: string }>> = {
  'PAS-3': { code: 'EX-EQT-003', subjectType: 'funding_round' },
  'FC-GPR': { code: 'EX-EQT-006', subjectType: 'share_transaction' },
  'FC-TRS': { code: 'EX-EQT-007', subjectType: 'share_transaction' },
  FLA: { code: 'EX-EQT-008', subjectType: 'holder' },
  'PAS-6': { code: 'EX-EQT-010', subjectType: 'company_profile' },
};

export interface RecordFilingInput {
  form: FilingForm;
  relatedType?: string | null;
  relatedId?: string | null;
  periodOrEvent: string;
  srn?: string | null;
  filedOn?: string | null;
  dueOn?: string | null;
  status: FilingStatus;
  note?: string | null;
}

export async function recordFiling(input: RecordFilingInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'compliance', verb: 'create' });

  if (!FILING_FORMS.includes(input.form)) throw ApiError.badRequest(`"${input.form}" is not a form this platform files.`);

  const row = await prisma.filing.create({
    data: {
      tenantId: auth.tenantId,
      recordCode: await nextRecordCode('FIL'),
      form: input.form,
      relatedType: input.relatedType ?? null,
      relatedId: input.relatedId ?? null,
      periodOrEvent: input.periodOrEvent,
      srn: input.srn ?? null,
      filedOn: input.filedOn ? new Date(input.filedOn) : null,
      dueOn: input.dueOn ? new Date(input.dueOn) : null,
      status: input.status,
      note: input.note ?? null,
      recordedByPartyId: auth.partyId ?? 'system',
    },
  });

  await auditWrite({ action: 'create', subjectType: 'filing', subjectId: row.id, after: row as never });
  await emit({
    name: EVENTS.FILING_RECORDED,
    subject: { entityType: 'filing', entityId: row.id, recordCode: row.recordCode },
    newState: { form: row.form, status: row.status },
  });

  if (input.status === 'filed') {
    const mapping = FORM_EXCEPTION[input.form];
    if (mapping) {
      const subjectId = mapping.subjectType === 'company_profile' ? (await companyProfile()).id : input.relatedId;
      if (subjectId) {
        const open = await prisma.exceptionRecord.findFirst({
          where: {
            tenantId: auth.tenantId,
            code: mapping.code,
            subjectType: mapping.subjectType,
            subjectId,
            state: { in: ['open', 'acknowledged', 'escalated'] },
          },
          orderBy: { createdAt: 'desc' },
        });
        if (open) {
          await resolveException(open.id, input.note ?? `Closed by recording ${input.form}${input.srn ? ` (SRN ${input.srn})` : ''}.`);
        }
      }
    }

    // PAS-3's own SRN/filed-on columns on the round — a real field the round
    // already carries (§6 phase 4), kept in step with the filing log rather
    // than left unwritten because a second calendar exists to record it in.
    if (input.form === 'PAS-3' && input.relatedType === 'funding_round' && input.relatedId) {
      await prisma.fundingRound.updateMany({
        where: { id: input.relatedId, tenantId: auth.tenantId },
        data: { pas3Srn: input.srn ?? null, pas3FiledOn: input.filedOn ? new Date(input.filedOn) : new Date() },
      });
    }
  }

  return filingView(row);
}

export async function listFilings(form?: string): Promise<FilingView[]> {
  const auth = currentAuth();
  await assertCan({ resource: 'compliance', verb: 'view' });
  const rows = await prisma.filing.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, ...(form ? { form } : {}) },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(filingView);
}

function filingView(row: {
  id: string; recordCode: string; form: string; relatedType: string | null; relatedId: string | null;
  periodOrEvent: string; srn: string | null; filedOn: Date | null; dueOn: Date | null; status: string;
  note: string | null; recordedByPartyId: string; createdAt: Date;
}): FilingView {
  return {
    id: row.id,
    recordCode: row.recordCode,
    form: row.form as never,
    relatedType: row.relatedType,
    relatedId: row.relatedId,
    periodOrEvent: row.periodOrEvent,
    srn: row.srn,
    filedOn: row.filedOn ? row.filedOn.toISOString() : null,
    dueOn: row.dueOn ? row.dueOn.toISOString() : null,
    status: row.status as never,
    note: row.note,
    recordedByPartyId: row.recordedByPartyId,
    createdAt: row.createdAt.toISOString(),
  };
}
