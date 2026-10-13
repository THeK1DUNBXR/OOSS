/**
 * Signing a contract raises a draft invoice from its value (events/handlers.ts). The draft is not
 * issued at signing (owner decision, 2026-10-13): an issue posts to the journal and needs a division
 * that signing does not carry. So signing posts nothing; finance sets the division and issues the draft,
 * and the issue posts its entry. These tests hold both halves, and the one-draft guard.
 */

import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../server.js';
import { asUser, principalFor, sessionToken, tenantId, unscopedPrisma, type TestPrincipal } from '../helpers.js';
import { assertTrialBalance, journalTrialBalance } from '../../platform/balances.js';
import { emit } from '../../platform/eventBus.js';
import { EVENTS } from '@kaizen/shared';
import { readyInvoicePosting } from '../fixtures/invoicePostingReady.js';

const LATHA = 'latha@kaizen.co.in';
let TENANT: string;
let latha: TestPrincipal;
let server: Server;
let base: string;

beforeAll(async () => {
  TENANT = await tenantId();
  await readyInvoicePosting(TENANT);
  latha = await principalFor(LATHA);
  server = createApp().listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}/api`;
});

async function call(method: 'POST' | 'PATCH', path: string, body: unknown) {
  const token = await sessionToken({
    userId: latha.userId,
    tenantId: latha.tenantId,
    affiliationId: latha.affiliationId,
    stepUp: true,
  });
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function signedContract() {
  const org = await unscopedPrisma.account.findFirstOrThrow({
    where: { tenantId: TENANT, gstin: { not: null } },
  });
  return unscopedPrisma.contract.create({
    data: {
      tenantId: TENANT,
      recordCode: `CTR-AUTO-${randomUUID().slice(0, 8)}`,
      title: 'Auto-invoice test contract',
      organizationId: org.organizationId,
      status: 'signed',
      commercialValueMinor: 500000n,
      currency: 'INR',
    },
  });
}

/** The CONTRACT_SIGNED event, emitted outside a transaction so its subscribers run now (eventBus.ts). */
async function signingEvent(contract: { id: string; recordCode: string }) {
  await asUser(LATHA, () =>
    emit({
      name: EVENTS.CONTRACT_SIGNED,
      subject: { entityType: 'contract', entityId: contract.id, recordCode: contract.recordCode },
      newState: { status: 'signed' },
      confidentiality: 'confidential',
      impact: { domains: ['fin'] },
    }),
  );
}

describe('signing a contract raises a draft invoice, and nothing posts until it is issued', () => {
  it('the signing creates one draft with no journal entry; a replayed signing creates no second one', async () => {
    const contract = await signedContract();
    await signingEvent(contract);

    const drafts = await unscopedPrisma.invoice.findMany({ where: { tenantId: TENANT, contractId: contract.id } });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.status).toBe('draft');
    expect(drafts[0]!.recordCode).toBeNull();
    expect(drafts[0]!.issuedDate).toBeNull();
    expect(await unscopedPrisma.journalEntry.count({ where: { tenantId: TENANT, sourceId: drafts[0]!.id } })).toBe(0);

    await signingEvent(contract);
    expect(await unscopedPrisma.invoice.count({ where: { tenantId: TENANT, contractId: contract.id } })).toBe(1);
  });

  it('finance sets the division on the draft, and issuing it posts the issue entry', async () => {
    const contract = await signedContract();
    await signingEvent(contract);
    const draft = await unscopedPrisma.invoice.findFirstOrThrow({
      where: { tenantId: TENANT, contractId: contract.id },
    });

    const withDivision = await call('PATCH', `/finance/invoices/${draft.id}`, { division: 'education' });
    expect(withDivision.status).toBe(200);

    const issued = await call('POST', `/finance/invoices/${draft.id}/issue`, {});
    expect(issued.status).toBe(200);
    expect(issued.body.status).toBe('issued');
    const entries = await unscopedPrisma.journalEntry.findMany({
      where: { tenantId: TENANT, sourceType: 'invoice', sourceId: draft.id },
    });
    expect(entries).toHaveLength(1);
    const tb = await asUser(LATHA, async () => journalTrialBalance(new Date()));
    expect(() => assertTrialBalance(tb)).not.toThrow();
  });
});
