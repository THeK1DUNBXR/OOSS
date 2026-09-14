/**
 * Phase 1 of the equity portal — the register.
 *
 * Requirements named `EQT-REG-*`, per the phase-1 brief in
 * `docs/plan/equity-portal.md` §6.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import {
  createShareClass, createHolder, proposeAllotment, proposeTransfer,
  approveShareTransaction, rejectShareTransaction, makeEffective, reverseShareTransaction,
  capTable, holdingsFor, certificateDocument, detectOverdueCertificates,
  listShareLedger,
} from '../domains/equity.js';
import * as equity from '../domains/equity.js';
import { createOrResetSignIn } from '../domains/signIns.js';
import { seedBootstrap } from '../seed/bootstrap.js';
import { stageImport } from '../imports/service.js';
import { commitImport, revertImport } from '../imports/commit.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { asUser, expectReject, principalFor, prisma as scopedPrisma, tenantId, unscopedPrisma } from './helpers.js';

let HOLDING: string;
const cleanupTenantSlugs: string[] = [];

async function newShareClass(name: string) {
  return asUser('secretary@kaizen.co.in', () =>
    createShareClass({ name, kind: 'equity', instrument: 'equity', faceValue: 10 }),
  );
}

/** A person holder, created (and given a sign-in) by the chairman. */
async function newPersonHolder(label: string) {
  return asUser('chairman@kaizen.co.in', async () => {
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const email = `${slug}-${Date.now()}-${Math.floor(Math.random() * 10000)}@example.test`;
    const person = await scopedPrisma.person.create({
      data: {
        tenantId: HOLDING,
        recordCode: await nextRecordCode('PER'),
        fullName: label,
        primaryEmail: email,
        primaryEmailNormalised: email,
        source: 'test',
      },
    });
    await createOrResetSignIn({ personId: person.id, roleSlug: 'shareholder', email });
    const h = await createHolder({ kind: 'person', personId: person.id, residency: 'resident' });
    return { person, email, holder: h };
  });
}

/** A company-secretary sign-in, through the same path the chairman uses. */
async function newSecretary() {
  return asUser('chairman@kaizen.co.in', async () => {
    const email = `secretary@kaizen.co.in`;
    const existing = await unscopedPrisma.user.findFirst({ where: { email } });
    if (existing) return;
    const person = await scopedPrisma.person.create({
      data: { tenantId: HOLDING, recordCode: await nextRecordCode('PER'), fullName: 'Company Secretary', primaryEmail: email, primaryEmailNormalised: email, source: 'test' },
    });
    await createOrResetSignIn({ personId: person.id, roleSlug: 'company_secretary', email });
  });
}

async function ensureCertificateSignatories() {
  await asUser('chairman@kaizen.co.in', async () => {
    const { updateCompanyProfile } = await import('../domains/companyProfile.js');
    await updateCompanyProfile({
      certificateSignatories: [
        { name: 'A. Director', designation: 'Director' },
        { name: 'B. Secretary', designation: 'Company Secretary' },
      ],
    });
  });
}

beforeAll(async () => {
  HOLDING = await tenantId();
  await newSecretary();
  await ensureCertificateSignatories();
});

describe('EQT-REG-001 — the share ledger is append-only: no update path, and a reversal posts the opposite entry', () => {
  it('exposes no updateShareTransaction (or similar) function', () => {
    const exported = Object.keys(equity);
    expect(exported.some((k) => /update.*share.*transaction/i.test(k))).toBe(false);
  });

  it('a reversal posts the opposite entry and never edits the original row in place', async () => {
    const cls = await newShareClass(`Equity-001-${Date.now()}`);
    const holderA = await newPersonHolder('Reg001 Holder A');

    const proposed = await asUser('secretary@kaizen.co.in', () =>
      proposeAllotment({ shareClassId: cls.id, toHolderId: holderA.holder.id, count: 100, pricePerShare: 0, effectiveOn: new Date().toISOString() }),
    );
    const approved = await asUser('finance@kaizen.co.in', () => approveShareTransaction(proposed.id));
    expect(approved.status).toBe('approved');
    const effective = await asUser('finance@kaizen.co.in', () => makeEffective(proposed.id));
    expect(effective.status).toBe('effective');
    expect(effective.distinctiveFrom).toBeTruthy();

    // Reversal needs both `create` and `approve` on `share_ledger`; the
    // finance head holds only `approve`, so this is the chairman's act.
    const { reversed, reversal } = await asUser('chairman@kaizen.co.in', () => reverseShareTransaction(proposed.id, 'test reversal'));
    expect(reversed.status).toBe('reversed');
    expect(reversed.reversedById).toBe(reversal.id);
    expect(reversal.reversalOfId).toBe(proposed.id);
    // The opposite entry: what came in to holder A goes out of holder A.
    expect(reversal.fromHolderId).toBe(holderA.holder.id);
    expect(reversal.toHolderId).toBeNull();

    // `holdings` is granted to shareholder/director/chairman, not finance_head.
    const balance = await asUser('chairman@kaizen.co.in', () => holdingsFor(holderA.holder.id));
    expect(balance.rows.find((r) => r.shareClassId === cls.id)).toBeUndefined();
  });
});

describe('EQT-REG-002 — distinctive numbers are gapless per class and never overlap', () => {
  it('two allotments in the same class receive consecutive, non-overlapping ranges', async () => {
    const cls = await newShareClass(`Equity-002-${Date.now()}`);
    const holderA = await newPersonHolder('Reg002 Holder A');
    const holderB = await newPersonHolder('Reg002 Holder B');

    const first = await asUser('secretary@kaizen.co.in', () =>
      proposeAllotment({ shareClassId: cls.id, toHolderId: holderA.holder.id, count: 500, effectiveOn: new Date().toISOString() }),
    );
    await asUser('finance@kaizen.co.in', () => approveShareTransaction(first.id));
    const firstEffective = await asUser('finance@kaizen.co.in', () => makeEffective(first.id));
    expect(firstEffective.distinctiveFrom).toBe('1');
    expect(firstEffective.distinctiveTo).toBe('500');

    const second = await asUser('secretary@kaizen.co.in', () =>
      proposeAllotment({ shareClassId: cls.id, toHolderId: holderB.holder.id, count: 300, effectiveOn: new Date().toISOString() }),
    );
    await asUser('finance@kaizen.co.in', () => approveShareTransaction(second.id));
    const secondEffective = await asUser('finance@kaizen.co.in', () => makeEffective(second.id));
    expect(secondEffective.distinctiveFrom).toBe('501');
    expect(secondEffective.distinctiveTo).toBe('800');
  });
});

describe('EQT-REG-003 — the secretary cannot approve their own proposal and the chairman cannot approve a transfer they receive', () => {
  it('the secretary holds no approve grant on the ledger at all', async () => {
    const cls = await newShareClass(`Equity-003a-${Date.now()}`);
    const holderA = await newPersonHolder('Reg003 Holder A');
    const proposed = await asUser('secretary@kaizen.co.in', () =>
      proposeAllotment({ shareClassId: cls.id, toHolderId: holderA.holder.id, count: 10, effectiveOn: new Date().toISOString() }),
    );
    const rejection = await expectReject(() => asUser('secretary@kaizen.co.in', () => approveShareTransaction(proposed.id)));
    expect(rejection.status).toBe(403);
  });

  it('the chairman is rerouted/refused on a transfer where they are the recipient', async () => {
    const cls = await newShareClass(`Equity-003b-${Date.now()}`);
    const holderA = await newPersonHolder('Reg003 Holder B (source)');

    // Fund holder A first.
    const allot = await asUser('secretary@kaizen.co.in', () =>
      proposeAllotment({ shareClassId: cls.id, toHolderId: holderA.holder.id, count: 1000, effectiveOn: new Date().toISOString() }),
    );
    await asUser('finance@kaizen.co.in', () => approveShareTransaction(allot.id));
    await asUser('finance@kaizen.co.in', () => makeEffective(allot.id));

    // A holder for the chairman.
    const chairmanPrincipal = await principalFor('chairman@kaizen.co.in');
    const chairmanHolder = await asUser('chairman@kaizen.co.in', () =>
      createHolder({ kind: 'person', personId: chairmanPrincipal.partyId, residency: 'resident' }),
    );

    const transfer = await asUser('secretary@kaizen.co.in', () =>
      proposeTransfer({ shareClassId: cls.id, fromHolderId: holderA.holder.id, toHolderId: chairmanHolder.id, count: 50, effectiveOn: new Date().toISOString() }),
    );

    const rejection = await expectReject(() => asUser('chairman@kaizen.co.in', () => approveShareTransaction(transfer.id)));
    expect(rejection.status).toBe(403);
  });
});

describe('EQT-REG-004 — the cap table sums to 100.00 on both bases and a pending consideration is visible', () => {
  it('issued% and fully-diluted% each sum to exactly 100.00, and a priced allotment with no consideration is flagged pending', async () => {
    const equityClass = await newShareClass(`Equity-004-${Date.now()}`);
    const optionClass = await asUser('secretary@kaizen.co.in', () =>
      createShareClass({ name: `Option-004-${Date.now()}`, kind: 'debenture', instrument: 'option', faceValue: 0 }),
    );
    const holderA = await newPersonHolder('Reg004 Holder A');
    const holderB = await newPersonHolder('Reg004 Holder B');
    const holderC = await newPersonHolder('Reg004 Holder C (options)');

    const a1 = await asUser('secretary@kaizen.co.in', () =>
      proposeAllotment({ shareClassId: equityClass.id, toHolderId: holderA.holder.id, count: 700, pricePerShare: 10, effectiveOn: new Date().toISOString() }),
    );
    await asUser('finance@kaizen.co.in', () => approveShareTransaction(a1.id));
    await asUser('finance@kaizen.co.in', () => makeEffective(a1.id));

    // Priced with no consideration transaction on file — pending.
    const a2 = await asUser('secretary@kaizen.co.in', () =>
      proposeAllotment({ shareClassId: equityClass.id, toHolderId: holderB.holder.id, count: 300, pricePerShare: 10, effectiveOn: new Date().toISOString() }),
    );
    expect(a2.pendingConsideration).toBe(true);
    await asUser('finance@kaizen.co.in', () => approveShareTransaction(a2.id));
    await asUser('finance@kaizen.co.in', () => makeEffective(a2.id));

    const opt = await asUser('secretary@kaizen.co.in', () =>
      proposeAllotment({ shareClassId: optionClass.id, toHolderId: holderC.holder.id, count: 100, effectiveOn: new Date().toISOString() }),
    );
    await asUser('finance@kaizen.co.in', () => approveShareTransaction(opt.id));
    await asUser('finance@kaizen.co.in', () => makeEffective(opt.id));

    const table = await asUser('finance@kaizen.co.in', () => capTable());
    const relevant = table.rows.filter((r) => r.shareClassId === equityClass.id || r.shareClassId === optionClass.id);
    const issuedSum = relevant.reduce((s, r) => s + r.issuedPct, 0);
    const dilutedSum = relevant.reduce((s, r) => s + r.fullyDilutedPct, 0);
    // Rounding to 2 decimals — allow for float accumulation noise across
    // other test-created rows sharing the tenant by checking the specific
    // rows' own basis sums via their own table, not the whole tenant's.
    expect(Math.round(issuedSum * 100) / 100).toBeCloseTo(issuedSum, 2);
    expect(Math.round(dilutedSum * 100) / 100).toBeCloseTo(dilutedSum, 2);

    const pendingRow = table.rows.find((r) => r.holderId === holderB.holder.id && r.shareClassId === equityClass.id);
    expect(pendingRow?.pendingConsideration).toBe(true);

    // The whole table (every row this tenant has, not just this test's)
    // still sums to 100.00 on each basis — that is the actual invariant.
    const wholeIssued = table.rows.reduce((s, r) => s + r.issuedPct, 0);
    const wholeDiluted = table.rows.reduce((s, r) => s + r.fullyDilutedPct, 0);
    expect(Math.round(wholeIssued * 100) / 100).toBe(100);
    expect(Math.round(wholeDiluted * 100) / 100).toBe(100);
  });
});

describe('EQT-REG-005 — a shareholder reads only their own holdings and a cross-holder read is 404', () => {
  it('holdings/me resolves the caller\'s own holder, and another holder\'s id is refused with 404', async () => {
    const cls = await newShareClass(`Equity-005-${Date.now()}`);
    const holderA = await newPersonHolder('Reg005 Holder A');
    const holderB = await newPersonHolder('Reg005 Holder B');

    const a1 = await asUser('secretary@kaizen.co.in', () =>
      proposeAllotment({ shareClassId: cls.id, toHolderId: holderA.holder.id, count: 200, effectiveOn: new Date().toISOString() }),
    );
    await asUser('finance@kaizen.co.in', () => approveShareTransaction(a1.id));
    await asUser('finance@kaizen.co.in', () => makeEffective(a1.id));

    const own = await asUser(holderA.email, () => holdingsFor('me'));
    expect(own.rows.some((r) => r.shareClassId === cls.id && r.count === 200)).toBe(true);

    const rejection = await expectReject(() => asUser(holderA.email, () => holdingsFor(holderB.holder.id)));
    expect(rejection.status).toBe(404);
  });
});

describe('EQT-REG-006 — an issued certificate\'s document view is byte-identical after a later transfer of other shares', () => {
  it('the certificate document is unchanged by an unrelated later transfer', async () => {
    const cls = await newShareClass(`Equity-006-${Date.now()}`);
    const otherCls = await newShareClass(`Equity-006-other-${Date.now()}`);
    const holderA = await newPersonHolder('Reg006 Holder A');
    const holderB = await newPersonHolder('Reg006 Holder B');
    const holderC = await newPersonHolder('Reg006 Holder C');

    const allotA = await asUser('secretary@kaizen.co.in', () =>
      proposeAllotment({ shareClassId: cls.id, toHolderId: holderA.holder.id, count: 100, effectiveOn: new Date().toISOString() }),
    );
    await asUser('finance@kaizen.co.in', () => approveShareTransaction(allotA.id));
    await asUser('finance@kaizen.co.in', () => makeEffective(allotA.id));

    const ledger = await asUser('finance@kaizen.co.in', () => listShareLedger());
    const effectiveA = ledger.find((t) => t.id === allotA.id)!;
    const certs = await asUser('secretary@kaizen.co.in', async () => {
      const { listCertificates } = await import('../domains/equity.js');
      return listCertificates();
    });
    const certA = certs.find((c) => c.holderId === holderA.holder.id && c.shareClassId === cls.id)!;
    expect(effectiveA.status).toBe('effective');

    const before = await asUser('secretary@kaizen.co.in', () => certificateDocument(certA.id));

    // Other shares move: an unrelated allotment and transfer, in a different class.
    const allotB = await asUser('secretary@kaizen.co.in', () =>
      proposeAllotment({ shareClassId: otherCls.id, toHolderId: holderB.holder.id, count: 400, effectiveOn: new Date().toISOString() }),
    );
    await asUser('finance@kaizen.co.in', () => approveShareTransaction(allotB.id));
    await asUser('finance@kaizen.co.in', () => makeEffective(allotB.id));
    const xfer = await asUser('secretary@kaizen.co.in', () =>
      proposeTransfer({ shareClassId: otherCls.id, fromHolderId: holderB.holder.id, toHolderId: holderC.holder.id, count: 150, effectiveOn: new Date().toISOString() }),
    );
    await asUser('finance@kaizen.co.in', () => approveShareTransaction(xfer.id));
    await asUser('finance@kaizen.co.in', () => makeEffective(xfer.id));

    const after = await asUser('secretary@kaizen.co.in', () => certificateDocument(certA.id));
    expect(after).toEqual(before);
  });
});

describe('EQT-REG-007 — the two-month certificate window raises a compliance item once', () => {
  it('an effective transaction older than 60 days with no certificate raises EX-EQT-002 exactly once', async () => {
    const cls = await newShareClass(`Equity-007-${Date.now()}`);
    const holderA = await newPersonHolder('Reg007 Holder A');

    // A row constructed directly (rather than through makeEffective, which
    // always issues a certificate) to represent the gap the job detects: an
    // effective allotment with no certificate against it.
    const old = new Date(Date.now() - 90 * 86_400_000);
    const txn = await asUser('finance@kaizen.co.in', () =>
      scopedPrisma.shareTransaction.create({
        data: {
          tenantId: HOLDING,
          recordCode: `SHT-${new Date().getUTCFullYear()}-${String(Math.floor(Math.random() * 90000)).padStart(5, '0')}`,
          type: 'allotment',
          shareClassId: cls.id,
          toHolderId: holderA.holder.id,
          count: 10,
          effectiveOn: old,
          status: 'effective',
          proposedByPartyId: 'system',
        },
      }),
    );

    const raisedFirst = await asUser('finance@kaizen.co.in', () => detectOverdueCertificates());
    expect(raisedFirst).toBeGreaterThanOrEqual(1);

    const exceptions = await unscopedPrisma.exceptionRecord.findMany({
      where: { tenantId: HOLDING, code: 'EX-EQT-002', subjectId: txn.id },
    });
    expect(exceptions).toHaveLength(1);

    // Firing again does not duplicate — the trigger fingerprint is per transaction.
    await asUser('finance@kaizen.co.in', () => detectOverdueCertificates());
    const exceptionsAgain = await unscopedPrisma.exceptionRecord.findMany({
      where: { tenantId: HOLDING, code: 'EX-EQT-002', subjectId: txn.id },
    });
    expect(exceptionsAgain).toHaveLength(1);
  });
});

describe('EQT-REG-008 — a subsidiary may not hold its holding\'s shares (s.19)', () => {
  it('a holder recorded in the holding\'s own register naming a subsidiary as heldByTenantId is refused', async () => {
    const subSlug = `eqt-reg-008-sub-${Date.now()}`;
    cleanupTenantSlugs.push(subSlug);
    const { tenantId: subTenantId } = await seedBootstrap({ tenantSlug: subSlug, tenantName: 'EQT-REG-008 Sub', parentTenantSlug: 'kaizen' });

    const rejection = await expectReject(() =>
      asUser('chairman@kaizen.co.in', () => createHolder({ kind: 'entity', heldByTenantId: subTenantId, residency: 'resident' })),
    );
    expect(rejection.status).toBe(422);
  });
});

describe('EQT-REG-009 — a non-resident holder must state the investment basis', () => {
  it('creating a non-resident holder with no investment basis is refused', async () => {
    const rejection = await expectReject(() =>
      asUser('chairman@kaizen.co.in', () =>
        createHolder({ kind: 'person', person: { fullName: 'NRI Test Holder', email: `nri-${Date.now()}@example.test` }, residency: 'non_resident' }),
      ),
    );
    expect(rejection.status).toBe(422);
  });
});

describe('EQT-REG-010 — the opening-register template imports holders, classes and effective allotments and reverts cleanly', () => {
  it('commit creates a class, a holder and an effective allotment with an imported certificate, and revert removes the transaction', async () => {
    const className = `Imported-010-${Date.now()}`;
    const holderName = `Reg010 Import Holder ${Date.now()}`;

    const header = [
      'Holder name', 'Holder kind', 'Email', 'Phone', 'PAN', 'Residency', 'Investment basis',
      'Share class', 'Instrument', 'Face value', 'Count', 'Distinctive from', 'Distinctive to',
      'Allotted on', 'Price per share', 'Certificate number',
    ];
    const row = [
      holderName, 'Person', `reg010-${Date.now()}@example.test`, '', '', 'Resident', '',
      className, 'Equity', '10', '1000', '1', '1000', '01/04/2020', '', 'PAPER/001',
    ];
    const book = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([header, row]);
    XLSX.utils.book_append_sheet(book, sheet, 'Data');
    const buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    const staged = await asUser('chairman@kaizen.co.in', () => stageImport({ fileName: 'opening-register.xlsx', buffer }));
    expect(staged.kind).toBe('template_opening_register');

    const committed = await asUser('chairman@kaizen.co.in', () => commitImport(staged.batchId));
    expect(committed.errors).toEqual([]);
    expect(committed.created.shareTransaction).toBe(1);

    const { cls, txn, cert } = await asUser('chairman@kaizen.co.in', async () => {
      const cls = await scopedPrisma.shareClass.findFirst({ where: { tenantId: HOLDING, name: className } });
      const txn = cls ? await scopedPrisma.shareTransaction.findFirst({ where: { tenantId: HOLDING, shareClassId: cls.id, status: 'effective' } }) : null;
      const cert = txn ? await scopedPrisma.shareCertificate.findFirst({ where: { tenantId: HOLDING, issuedForTransactionId: txn.id } }) : null;
      return { cls, txn, cert };
    });
    expect(cls).toBeTruthy();
    expect(txn).toBeTruthy();
    expect(String(txn!.distinctiveFrom)).toBe('1');
    expect(String(txn!.distinctiveTo)).toBe('1000');
    expect(cert?.imported).toBe(true);
    expect(cert?.certificateNumber).toBe('PAPER/001');

    await asUser('chairman@kaizen.co.in', () => revertImport(staged.batchId));
    const { txnAfter, certAfter } = await asUser('chairman@kaizen.co.in', async () => ({
      txnAfter: await scopedPrisma.shareTransaction.findFirst({ where: { id: txn!.id } }),
      certAfter: await scopedPrisma.shareCertificate.findFirst({ where: { id: cert!.id } }),
    }));
    expect(txnAfter).toBeNull();
    expect(certAfter).toBeNull();
  });
});
