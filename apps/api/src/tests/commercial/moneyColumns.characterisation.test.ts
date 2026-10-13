/**
 * Characterisation of the commercial and pipeline money columns as they reach the
 * wire and the gates today (ORDERED-PLAN 1.6, MONEY-S6 part 2): the seventeen
 * columns on Lead, Opportunity, Proposal, Quote, QuoteLine, Mou, Contract,
 * PartnerAgreement, WinLossReview, PriceBookEntry, AuthorityGrant and ApprovalStep.
 *
 * Read over HTTP through the real router and Postgres, and through the domain
 * functions the gates run. Every expected value is a figure a person would type,
 * so the same assertions must pass on the Decimal and Number columns and, with
 * the rupee fields still sent, on the BigInt `*Minor` columns. Setup rows are
 * written with the column the schema has at the time of the run.
 *
 * Boundaries: the authority ceiling is pinned at equal, one paisa over and one
 * paisa under, through evaluate() HOW MUCH, the approval gate, and the number
 * ceiling the gate reads. A grant with no ceiling resolves to 0, not to "no
 * grant", and that is pinned too.
 */

import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../server.js';
import { unscopedPrisma } from '../../platform/db.js';
import { evaluate, resolveAuthorityCeiling, resolveAuthorityCeilingPaise } from '../../platform/permissions.js';
import { authFor, asUser, expectReject, principalFor, sessionToken, tenantId, type TestPrincipal } from '../helpers.js';
import { createOpportunity, changeForecastCategory } from '../../domains/opportunities.js';
import { createMou } from '../../domains/agreements.js';
import { transitionAgreement } from '../../domains/agreements.js';
import { validateTransition } from '../../domains/pipelines.js';

const CHAIRMAN = 'chairman@kaizen.co.in';
const FINANCE = 'finance@kaizen.co.in';

let server: Server;
let base: string;
let TENANT: string;
let chairman: TestPrincipal;
let finance: TestPrincipal;
let financeOrgId: string;
let token: string;
const createdGrantIds: string[] = [];
const pausedGrantIds: string[] = [];

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 100000)}`;

beforeAll(async () => {
  TENANT = await tenantId();
  chairman = await principalFor(CHAIRMAN);
  finance = await principalFor(FINANCE);
  token = await sessionToken({
    userId: chairman.userId,
    tenantId: chairman.tenantId,
    affiliationId: chairman.affiliationId,
    stepUp: true,
  });
  server = createApp().listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}/api`;
});

afterAll(async () => {
  server?.close();
  // The finance principal's own grants are put back as they were: the ceiling
  // tests pause the seeded ones and then hold a grant of their own.
  if (createdGrantIds.length) {
    await unscopedPrisma.authorityGrant.updateMany({
      where: { id: { in: createdGrantIds } },
      data: { status: 'revoked' },
    });
  }
  if (pausedGrantIds.length) {
    await unscopedPrisma.authorityGrant.updateMany({
      where: { id: { in: pausedGrantIds } },
      data: { status: 'active' },
    });
  }
});

/** A request as the chairman, with the JSON body and status. */
async function call(method: 'GET' | 'POST', path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** The first object with this id anywhere in a response, however it is nested. */
function findById(node: unknown, id: string): any {
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findById(item, id);
      if (hit) return hit;
    }
    return null;
  }
  if (node && typeof node === 'object') {
    if ((node as { id?: unknown }).id === id) return node;
    for (const value of Object.values(node)) {
      const hit = findById(value, id);
      if (hit) return hit;
    }
  }
  return null;
}

/** Pauses the principal's active grants of one class, so a test holds the only grant that counts. */
async function pauseGrants(partyId: string, authorityClass: string) {
  const rows = await unscopedPrisma.authorityGrant.findMany({
    where: { tenantId: TENANT, principalId: partyId, authorityClass, status: 'active' },
    select: { id: true },
  });
  for (const row of rows) {
    pausedGrantIds.push(row.id);
    await unscopedPrisma.authorityGrant.update({ where: { id: row.id }, data: { status: 'paused' } });
  }
}

/** Retires the one active grant this test puts in place, so the next test holds its own. */
async function retireGrant(id: string) {
  await unscopedPrisma.authorityGrant.update({ where: { id }, data: { status: 'revoked' } });
}

describe('MONEY-S6 part 2: price book, quotes, proposals and agreements on the wire', () => {
  let offeringId: string;
  let entryId: string;
  let quoteOpportunityId: string;

  beforeAll(async () => {
    const offering = await call('POST', '/commercial/offerings', {
      offeringCode: `S6P2-${stamp()}`,
      name: `S6 part 2 offering ${stamp()}`,
      vertical: 'software_ai',
      deliveryModel: 'cohort',
    });
    expect(offering.status).toBe(201);
    offeringId = offering.body.id;
    quoteOpportunityId = (await unscopedPrisma.opportunity.findFirstOrThrow({ where: { tenantId: TENANT } })).id;
  });

  it('a published price is sent as the Decimal string it always was, and listed as a number', async () => {
    const published = await call('POST', `/commercial/offerings/${offeringId}/prices`, {
      currency: 'INR',
      unitPrice: 1000.25,
      billingFrequency: 'one_time',
      maxDiscountPct: 100,
    });
    expect(published.status).toBe(201);
    expect(published.body.unitPrice).toBe('1000.25');
    entryId = published.body.id;

    const prices = await call('GET', `/commercial/offerings/${offeringId}/prices`);
    expect(prices.status).toBe(200);
    expect(prices.body[0].unitPrice).toBe('1000.25');

    const offerings = await call('GET', '/commercial/offerings');
    const offering = findById(offerings.body, offeringId);
    expect(offering.activePriceBookEntries[0].unitPrice).toBe(1000.25);
  });

  it('a quote with one discounted line totals to the paisa, half-paisa rounded up', async () => {
    // 1000.25 x 3 = 3000.75; 10% is 300.075, which is a half paisa.
    const created = await call('POST', '/commercial/quotes', {
      opportunityId: quoteOpportunityId,
      lines: [{ priceBookEntryId: entryId, quantity: 3, discountPct: 10 }],
    });
    expect(created.status).toBe(201);
    expect(created.body.subtotal).toBe('3000.75');
    expect(created.body.discountTotal).toBe('300.08');
    expect(created.body.grandTotal).toBe('2700.68');

    const listed = await call('GET', `/commercial/quotes?opportunityId=${quoteOpportunityId}`);
    const quote = findById(listed.body, created.body.id);
    expect(quote.subtotal).toBe(3000.75);
    expect(quote.discountTotal).toBe(300.08);
    expect(quote.grandTotal).toBe(2700.68);
    expect(quote.lines[0].listUnitPrice).toBe(1000.25);
    expect(quote.lines[0].discountAmount).toBe(300.08);
    expect(quote.lines[0].lineTotal).toBe(2700.68);
  });

  it('two lines with a half-paisa discount each: the quote total is not the sum of its rounded lines', async () => {
    // Line B: 100.05 x 1 at 10% is 10.005, a tie. Line A: 300.075, a tie.
    // The quote discount is the rounded total of the exact discounts, 310.08,
    // which is not 300.08 + 10.01 = 310.09. Pinned here so the conversion keeps it.
    const offeringB = await call('POST', '/commercial/offerings', {
      offeringCode: `S6P2B-${stamp()}`,
      name: `S6 part 2 offering B ${stamp()}`,
      vertical: 'software_ai',
      deliveryModel: 'cohort',
    });
    const second = await call('POST', `/commercial/offerings/${offeringB.body.id}/prices`, {
      currency: 'INR',
      unitPrice: 100.05,
      billingFrequency: 'one_time',
      maxDiscountPct: 100,
    });
    expect(second.status).toBe(201);

    const created = await call('POST', '/commercial/quotes', {
      opportunityId: quoteOpportunityId,
      lines: [
        { priceBookEntryId: entryId, quantity: 3, discountPct: 10 },
        { priceBookEntryId: second.body.id, quantity: 1, discountPct: 10 },
      ],
    });
    expect(created.status).toBe(201);
    expect(created.body.subtotal).toBe('3100.8');
    expect(created.body.discountTotal).toBe('310.08');
    expect(created.body.grandTotal).toBe('2790.72');

    const listed = await call('GET', `/commercial/quotes?opportunityId=${quoteOpportunityId}`);
    const quote = findById(listed.body, created.body.id);
    expect(quote.lines.map((l: any) => l.discountAmount)).toEqual([300.08, 10.01]);
    expect(quote.lines.map((l: any) => l.lineTotal)).toEqual([2700.68, 90.05]);
  });

  it('a proposal total goes out as a Decimal string on create and as a number on the list', async () => {
    const created = await call('POST', '/commercial/proposals', {
      opportunityId: quoteOpportunityId,
      title: `S6 part 2 proposal ${stamp()}`,
      totalValue: 5000.5,
    });
    expect(created.status).toBe(201);
    expect(created.body.totalValue).toBe('5000.5');

    const listed = await call('GET', '/commercial/proposals');
    expect(findById(listed.body, created.body.id).totalValue).toBe(5000.5);
  });

  it('an MoU, a contract and a partner agreement carry their value as a Decimal string, then a number', async () => {
    const org = await unscopedPrisma.organization.findFirstOrThrow({ where: { tenantId: TENANT } });

    const mou = await call('POST', '/commercial/mous', {
      title: `S6 MoU ${stamp()}`,
      organizationId: org.id,
      commercialValue: 1234.56,
    });
    expect(mou.status).toBe(201);
    expect(mou.body.commercialValue).toBe('1234.56');
    const mous = await call('GET', '/commercial/mous');
    expect(findById(mous.body, mou.body.id).commercialValue).toBe(1234.56);

    const contract = await call('POST', '/commercial/contracts', {
      title: `S6 contract ${stamp()}`,
      commercialValue: 2500.75,
    });
    expect(contract.status).toBe(201);
    expect(contract.body.commercialValue).toBe('2500.75');
    const contracts = await call('GET', '/commercial/contracts');
    expect(findById(contracts.body, contract.body.id).commercialValue).toBe(2500.75);

    const partner = await call('POST', '/commercial/partner-agreements', {
      title: `S6 partner ${stamp()}`,
      partnerOrganizationId: org.id,
      agreementType: 'reseller',
      commercialValue: 700.1,
    });
    expect(partner.status).toBe(201);
    expect(partner.body.commercialValue).toBe('700.1');
    const partners = await call('GET', '/commercial/partner-agreements');
    expect(findById(partners.body, partner.body.id).commercialValue).toBe(700.1);
  });

  it('a win/loss snapshot is a number on the wire', async () => {
    const review = await unscopedPrisma.winLossReview.create({
      data: {
        tenantId: TENANT,
        recordCode: `WL-S6P2-${stamp()}`,
        subjectType: 'opportunity',
        subjectId: `s6p2-${stamp()}`,
        outcome: 'lost',
        commercialValueSnapshotMinor: 150050n,
        thresholdUsedSnapshotMinor: 25025n,
      },
    });
    const listed = await call('GET', '/commercial/win-loss?pending=true');
    const row = findById(listed.body, review.id);
    expect(row.commercialValueSnapshot).toBe(1500.5);
    expect(row.thresholdUsedSnapshot).toBe(250.25);
  });
});

describe('MONEY-S6 part 2: leads and opportunities on the wire, and the commit gate', () => {
  it('a lead estimate goes out as a Decimal string on create and as a number on the list', async () => {
    const created = await call('POST', '/crm/leads', {
      title: `S6 part 2 lead ${stamp()}`,
      vertical: 'software_ai',
      estimatedValue: 300000.5,
    });
    expect(created.status).toBe(201);
    expect(created.body.estimatedValue).toBe('300000.5');

    const listed = await call('GET', '/crm/leads');
    expect(findById(listed.body, created.body.id).estimatedValue).toBe(300000.5);
  });

  it('an opportunity value is a number on the pipeline board', async () => {
    const pipeline = await unscopedPrisma.pipelineDefinition.findFirstOrThrow({
      where: { tenantId: TENANT, pipelineCode: 'PL-ENTERPRISE', effectiveTo: null },
    });
    const opportunity = await asUser(CHAIRMAN, () =>
      createOpportunity({
        title: `S6 part 2 opportunity ${stamp()}`,
        vertical: 'corporate_training',
        pipelineId: pipeline.id,
        expectedValue: 9000.75,
        expectedCloseDate: new Date(Date.now() + 30 * 86_400_000),
      }),
    );
    const board = await call('GET', `/pipelines/${pipeline.id}/board`);
    expect(board.status).toBe(200);
    expect(findById(board.body, opportunity.id).expectedValue).toBe(9000.75);
  });

  it('the commit gate reads the expected value by its name: missing blocks, present passes', async () => {
    const pipeline = await unscopedPrisma.pipelineDefinition.findFirstOrThrow({
      where: { tenantId: TENANT, pipelineCode: 'PL-ENTERPRISE', effectiveTo: null },
    });
    const opportunity = await asUser(CHAIRMAN, () =>
      createOpportunity({
        title: `S6 part 2 commit ${stamp()}`,
        vertical: 'corporate_training',
        pipelineId: pipeline.id,
        expectedCloseDate: new Date(Date.now() + 30 * 86_400_000),
      }),
    );
    // The commit gate reads the qualified stage's required fields, so the opportunity sits there.
    await unscopedPrisma.opportunity.update({
      where: { id: opportunity.id },
      data: { stageKey: 'qualified', forecastCategory: 'best_case' },
    });

    const refused = await asUser(CHAIRMAN, () =>
      expectReject(() => changeForecastCategory({ opportunityId: opportunity.id, to: 'commit', reason: 'S6P2' })),
    );
    expect(refused.status).toBe(422);
    expect(refused.message).toMatch(/expectedValue/);

    await unscopedPrisma.opportunity.update({
      where: { id: opportunity.id },
      data: { expectedValueMinor: 900075n },
    });
    await asUser(CHAIRMAN, () =>
      changeForecastCategory({ opportunityId: opportunity.id, to: 'commit', reason: 'S6P2' }),
    );
    const after = await unscopedPrisma.opportunity.findFirstOrThrow({ where: { id: opportunity.id } });
    expect(after.forecastCategory).toBe('commit');
  });

  it('the stage check names expectedValue too: a missing value is reported, a present one is not', async () => {
    const pipeline = await unscopedPrisma.pipelineDefinition.findFirstOrThrow({
      where: { tenantId: TENANT, pipelineCode: 'PL-ENTERPRISE', effectiveTo: null },
    });
    const base = await unscopedPrisma.opportunity.findFirstOrThrow({
      where: { tenantId: TENANT, pipelineId: pipeline.id },
    });
    const future = new Date(Date.now() + 30 * 86_400_000);
    const missing = await asUser(CHAIRMAN, () =>
      validateTransition(pipeline.id, 'engaged', 'qualified', {
        ...base,
        expectedValueMinor: null,
        expectedCloseDate: future,
      }),
    );
    expect(missing.ok).toBe(false);
    expect(missing.missingRequiredFields).toEqual(['expectedValue']);

    const present = await asUser(CHAIRMAN, () =>
      validateTransition(pipeline.id, 'engaged', 'qualified', {
        ...base,
        expectedValueMinor: 900075n,
        expectedCloseDate: future,
      }),
    );
    expect(present.ok).toBe(true);
    expect(present.missingRequiredFields).toEqual([]);
  });
});

describe('MONEY-S6 part 2: the authority ceiling at equal, one paisa over and one paisa under', () => {
  beforeAll(async () => {
    financeOrgId = (await unscopedPrisma.organization.findFirstOrThrow({ where: { tenantId: TENANT } })).id;
    await pauseGrants(finance.partyId, 'mou_approval');
    const grant = await unscopedPrisma.authorityGrant.create({
      data: {
        tenantId: TENANT,
        principalType: 'human',
        principalId: finance.partyId,
        authorityClass: 'mou_approval',
        ceilingValueMinor: 30000n,
        currency: 'INR',
        status: 'active',
        effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      },
    });
    createdGrantIds.push(grant.id);
  });

  it('the paise ceiling and the number ceiling read the same grant', async () => {
    const auth = authFor(finance);
    await asUser(FINANCE, async () => {
      expect(await resolveAuthorityCeilingPaise(auth, 'mou_approval')).toBe(30000n);
      expect(await resolveAuthorityCeiling(auth, 'mou_approval')).toBe(300);
    });
  });

  it('evaluate() HOW MUCH: equal and one paisa under pass, one paisa over is refused', async () => {
    const howMuch = (value: bigint) =>
      asUser(FINANCE, async () => {
        const decision = await evaluate({
          resource: 'mous',
          verb: 'approve',
          magnitude: { authorityClass: 'mou_approval', value },
        });
        return decision.axes.find((a) => a.axis === 'HOW_MUCH')?.passed;
      });
    expect(await howMuch(30000n)).toBe(true);
    expect(await howMuch(29999n)).toBe(true);
    expect(await howMuch(30001n)).toBe(false);
  });

  it('the approval gate: equal and one paisa under are permitted, one paisa over opens a step with that value', async () => {
    // Created by the chairman and approved by finance: a finance-owned MoU is a
    // self-dealing case, which reroutes a tier and would not test the ceiling.
    const transition = async (value: number) => {
      const mou = await asUser(CHAIRMAN, () =>
        createMou({ title: `S6 ceiling ${stamp()}`, organizationId: financeOrgId, commercialValue: value }),
      );
      return asUser(FINANCE, () => transitionAgreement('mou', mou.id, 'approved', 'S6P2 ceiling'));
    };

    const equal = await transition(300);
    expect(equal.applied).toBe(true);
    expect(equal.approvalStepId).toBeNull();

    const under = await transition(299.99);
    expect(under.applied).toBe(true);

    const over = await transition(300.01);
    expect(over.applied).toBe(false);
    expect(over.approvalStepId).not.toBeNull();

    const queue = await call('GET', '/commercial/approvals');
    const step = findById(queue.body, over.approvalStepId!);
    expect(step.requestedValue).toBe(300.01);
    expect(typeof step.requestedValue).toBe('number');
  });

  it('a grant with no ceiling resolves to 0, not to "no grant": zero passes, one paisa does not', async () => {
    await retireGrant(createdGrantIds[0]!);
    const grant = await unscopedPrisma.authorityGrant.create({
      data: {
        tenantId: TENANT,
        principalType: 'human',
        principalId: finance.partyId,
        authorityClass: 'mou_approval',
        ceilingValueMinor: null,
        currency: 'INR',
        status: 'active',
        effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      },
    });
    createdGrantIds.push(grant.id);

    const auth = authFor(finance);
    await asUser(FINANCE, async () => {
      expect(await resolveAuthorityCeiling(auth, 'mou_approval')).toBe(0);
      expect(await resolveAuthorityCeilingPaise(auth, 'mou_approval')).toBe(0n);
    });

    const transition = async (value: number) => {
      const mou = await asUser(CHAIRMAN, () =>
        createMou({ title: `S6 zero ${stamp()}`, organizationId: financeOrgId, commercialValue: value }),
      );
      return asUser(FINANCE, () => transitionAgreement('mou', mou.id, 'approved', 'S6P2 zero ceiling'));
    };
    expect((await transition(0)).applied).toBe(true);
    expect((await transition(0.01)).applied).toBe(false);
  });
});

describe('MONEY-S6 part 2: the admin grant list', () => {
  it('an authority grant ceiling is a number on the list', async () => {
    const grant = await unscopedPrisma.authorityGrant.create({
      data: {
        tenantId: TENANT,
        principalType: 'human',
        principalId: chairman.partyId,
        authorityClass: `s6p2_${stamp()}`,
        ceilingValueMinor: 432150n,
        currency: 'INR',
        status: 'active',
        effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      },
    });
    createdGrantIds.push(grant.id);
    const listed = await call('GET', '/admin/authority-grants');
    expect(listed.status).toBe(200);
    expect(findById(listed.body, grant.id).ceilingValue).toBe(4321.5);
  });
});
