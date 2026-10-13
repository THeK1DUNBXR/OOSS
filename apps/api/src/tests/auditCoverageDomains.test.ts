/**
 * FX-22, remaining domains: the writes these files made without an audit row now
 * write one, in the transaction the write commits in (CLAUDE.md rule 5). One
 * representative write per domain is driven through its public function, and the
 * audit log is checked for the row that write must leave on the subject it changed.
 *
 * Each test makes its own records, so none depends on the demo rows another test
 * might change.
 */

import { describe, expect, it } from 'vitest';
import { createInvoice } from '../domains/invoicing.js';
import { classifyInvoiceLine } from '../domains/compliance/gst.js';
import { issueFeeInstalments } from '../domains/finance.js';
import { addBoardPackItem, callMeeting } from '../domains/board.js';
import { encryptHolderPansAtRest } from '../domains/equity.js';
import { createMou, transitionAgreement } from '../domains/agreements.js';
import { createVendor } from '../domains/marketing/budget.js';
import { asUser, tenantId, unscopedPrisma } from './helpers.js';

const CHAIRMAN = 'chairman@kaizen.co.in';
const stamp = () => `${Date.now()}${Math.floor(Math.random() * 100000)}`;

/** The audit rows for one subject, optionally narrowed to one action. */
async function auditRowsFor(tid: string, subjectType: string, subjectId: string, action?: string) {
  return unscopedPrisma.auditRecord.findMany({
    where: { tenantId: tid, subjectType, subjectId, ...(action ? { action } : {}) },
  });
}

describe('FX-22 remaining domains: each representative write leaves one audit row', () => {
  it('finance: issuing a fee instalment audits its create', async () => {
    const tid = await tenantId();
    const enrollmentId = `enr-fx22-${stamp()}`;
    const [instalment] = await asUser(CHAIRMAN, () =>
      issueFeeInstalments(enrollmentId, [{ amount: 1500, dueDate: new Date('2099-03-31T00:00:00Z') }]),
    );
    const rows = await auditRowsFor(tid, 'fee_instalment', instalment.id, 'create');
    expect(rows).toHaveLength(1);
  });

  it('invoicing: a draft line is audited as it is written', async () => {
    const tid = await tenantId();
    const org = await unscopedPrisma.organization.findFirstOrThrow({ where: { tenantId: tid } });
    const draft = await asUser(CHAIRMAN, () =>
      createInvoice({
        division: 'education',
        organizationId: org.id,
        issue: false,
        lines: [{ description: `FX-22 line ${stamp()}`, unitPrice: 1000, gstRate: 18 }],
      }),
    );
    const line = await unscopedPrisma.invoiceLine.findFirstOrThrow({ where: { invoiceId: draft.id } });
    const rows = await auditRowsFor(tid, 'invoice_line', line.id, 'create');
    expect(rows).toHaveLength(1);
  });

  it('gst: reclassifying a draft line audits the invoice totals it recomputes', async () => {
    const tid = await tenantId();
    const org = await unscopedPrisma.organization.findFirstOrThrow({ where: { tenantId: tid } });
    const draft = await asUser(CHAIRMAN, () =>
      createInvoice({
        division: 'education',
        organizationId: org.id,
        issue: false,
        lines: [{ description: `FX-22 gst ${stamp()}`, unitPrice: 2000, gstRate: 18 }],
      }),
    );
    const line = await unscopedPrisma.invoiceLine.findFirstOrThrow({ where: { invoiceId: draft.id } });
    const before = (await auditRowsFor(tid, 'invoice', draft.id, 'update')).length;
    await asUser(CHAIRMAN, () => classifyInvoiceLine(draft.id, line.id, { supplyType: 'taxable', gstRate: 18 }));
    const after = (await auditRowsFor(tid, 'invoice', draft.id, 'update')).length;
    expect(after - before).toBe(1);
  });

  it('board: adding a pack item audits its create', async () => {
    const tid = await tenantId();
    const meeting = await asUser(CHAIRMAN, () =>
      callMeeting({
        kind: 'board',
        title: `FX-22 board ${stamp()}`,
        scheduledFor: new Date('2099-06-01T04:00:00Z'),
        mode: 'physical',
      }),
    );
    const item = await asUser(CHAIRMAN, () =>
      addBoardPackItem(meeting.id, { title: 'FX-22 notice', kind: 'notice', fileRef: `fx22/${stamp()}.pdf` }),
    );
    const rows = await auditRowsFor(tid, 'board_pack_item', item.id, 'create');
    expect(rows).toHaveLength(1);
  });

  it('equity: sealing a plaintext PAN audits the holder, without the PAN', async () => {
    const tid = await tenantId();
    const holder = await unscopedPrisma.holder.create({
      data: {
        tenantId: tid,
        recordCode: `HLD-FX22-${stamp()}`,
        kind: 'person',
        folioNumber: `F-FX22-${stamp()}`,
        panNumber: 'ABCDE1234F',
      },
    });
    await asUser(CHAIRMAN, () => encryptHolderPansAtRest());
    const rows = await auditRowsFor(tid, 'holder', holder.id, 'update');
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0].meta)).not.toContain('ABCDE1234F');
  });

  it('agreements: a status transition audits the update in its transaction', async () => {
    const tid = await tenantId();
    const org = await unscopedPrisma.organization.findFirstOrThrow({ where: { tenantId: tid } });
    const mou = await asUser(CHAIRMAN, () =>
      createMou({ title: `FX-22 MoU ${stamp()}`, organizationId: org.id, scope: 'FX-22 probe' }),
    );
    const result = await asUser(CHAIRMAN, () => transitionAgreement('mou', mou.id, 'negotiating'));
    expect(result.applied).toBe(true);
    const rows = await auditRowsFor(tid, 'mou', mou.id, 'update');
    expect(rows).toHaveLength(1);
  });

  it('marketing: creating a vendor audits its create', async () => {
    const tid = await tenantId();
    const org = await unscopedPrisma.organization.findFirstOrThrow({ where: { tenantId: tid } });
    const vendor = await asUser(CHAIRMAN, () => createVendor({ organizationId: org.id, services: ['fx22'] }));
    const rows = await auditRowsFor(tid, 'marketing_vendor', vendor.id, 'create');
    expect(rows).toHaveLength(1);
  });
});
