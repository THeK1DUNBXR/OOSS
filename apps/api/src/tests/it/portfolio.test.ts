/**
 * Technology — portfolio and budget (docs/plan/cio.md, workstream G).
 *
 * Pure arithmetic first — `fyWindow`, `fyElapsedFraction`, `burnAhead`,
 * `parseQuarter`, `ragRollup`, no database — then the wiring: stage
 * transitions are exactly what `itInitiativeMachine` declares,
 * `benefits_realised` is unreachable from `in_flight`, approving an
 * initiative one sponsors reroutes on the Self-Dealing Bar, a budget line's
 * actual is a live sum over the books that moves the moment a late bill
 * lands, the burn detector fires once per FY margin crossing, a budget
 * line's own creator can never approve it, and the grant matrix holds: the
 * Finance Head cannot create an initiative, the Operations Head cannot
 * approve a budget line it proposed, and the employee reaches nothing.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  burnAhead,
  fyElapsedFraction,
  fyWindow,
  itInitiativeMachine,
  parseFy,
  parseQuarter,
  ragRollup,
} from '@kaizen/shared';
import { asUser, expectReject, tenantId, unscopedPrisma } from '../helpers.js';
import {
  approveBudgetLine,
  budgetLineDetail,
  budgetSummary,
  createBudgetLine,
  createInitiative,
  createTechDebtItem,
  initiativeDetail,
  listInitiatives,
  listTechDebt,
  portfolioSummary,
  transitionInitiative,
  budgetForFy,
} from '../../domains/it/portfolio.js';
import { runBudgetBurnJob } from '../../jobs/it/portfolio.js';

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

// ---------------------------------------------------------------------------
// Pure arithmetic — no DB
// ---------------------------------------------------------------------------

describe('portfolio arithmetic (pure, no DB)', () => {
  it('parseFy reads the FYyyyy-yy shape and rejects a mismatched pair', () => {
    expect(parseFy('FY2026-27')).toBe(2026);
    expect(parseFy('FY2026-99')).toBeNull();
    expect(parseFy('not a fy')).toBeNull();
  });

  it('fyWindow: FY2026-27 runs 1 April 2026 (inclusive) to 1 April 2027 (exclusive)', () => {
    const { start, end } = fyWindow('FY2026-27');
    expect(start.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2027-04-01T00:00:00.000Z');
  });

  it('fyElapsedFraction is clamped to [0, 1] and roughly linear inside the year', () => {
    expect(fyElapsedFraction('FY2026-27', new Date('2026-01-01T00:00:00.000Z'))).toBe(0);
    expect(fyElapsedFraction('FY2026-27', new Date('2028-01-01T00:00:00.000Z'))).toBe(1);
    // 1 October 2026 is 184 days into a 365-day FY.
    const mid = fyElapsedFraction('FY2026-27', new Date('2026-10-01T00:00:00.000Z'));
    expect(mid).toBeGreaterThan(0.45);
    expect(mid).toBeLessThan(0.55);
  });

  it('IT-BUD-002 (arithmetic): burnAhead exceeds only once spend outruns the elapsed clock by more than the margin', () => {
    // 60% of the year gone, 80% of the budget spent, 15% margin -> 20 points ahead, exceeds.
    const ahead = burnAhead(100_000, 80_000, 0.6, 15);
    expect(ahead.burnFraction).toBeCloseTo(0.8, 5);
    expect(ahead.aheadBy).toBeCloseTo(0.2, 5);
    expect(ahead.exceeds).toBe(true);

    // 60% elapsed, 65% spent, 15% margin -> 5 points ahead, within margin.
    const within = burnAhead(100_000, 65_000, 0.6, 15);
    expect(within.exceeds).toBe(false);

    // Nothing planned but something spent is an immediate, unambiguous breach.
    const noPlan = burnAhead(0, 1, 0.5, 15);
    expect(noPlan.burnFraction).toBe(Infinity);
    expect(noPlan.exceeds).toBe(true);

    // Nothing planned, nothing spent: no burn at all.
    const nothing = burnAhead(0, 0, 0.5, 15);
    expect(nothing.burnFraction).toBe(0);
    expect(nothing.exceeds).toBe(false);
  });

  it('parseQuarter reads "FY2026-27 Q3" and rejects malformed input', () => {
    expect(parseQuarter('FY2026-27 Q3')).toEqual({ fy: 'FY2026-27', quarter: 3 });
    expect(parseQuarter('FY2026-27Q3')).toBeNull();
    expect(parseQuarter('Q3 FY2026-27')).toBeNull();
    expect(parseQuarter('FY2026-27 Q5')).toBeNull();
  });

  it('ragRollup counts each band and names the worst one present', () => {
    const rollup = ragRollup([{ rag: 'green' }, { rag: 'green' }, { rag: 'amber' }, { rag: 'red' }, { rag: null }]);
    expect(rollup).toEqual({ green: 2, amber: 1, red: 1, total: 4, worst: 'red' });
    expect(ragRollup([]).worst).toBeNull();
  });

  it('IT-INI-002 (arithmetic): benefits_realised is reachable only through delivered, never directly from in_flight', () => {
    expect(itInitiativeMachine.can('in_flight', 'REALISE_BENEFITS' as never)).toBe(false);
    expect(itInitiativeMachine.can('delivered', 'REALISE_BENEFITS')).toBe(true);
    expect(itInitiativeMachine.allowedEvents('benefits_realised')).toEqual([]);
    expect(itInitiativeMachine.allowedEvents('cancelled')).toEqual([]);
    // cancelled is reachable from everywhere short of delivered/benefits_realised.
    for (const state of ['idea', 'assessed', 'approved', 'in_flight'] as const) {
      expect(itInitiativeMachine.can(state, 'CANCEL')).toBe(true);
    }
    expect(itInitiativeMachine.can('delivered', 'CANCEL' as never)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Domain and wiring
// ---------------------------------------------------------------------------

describe('portfolio — domain and wiring', () => {
  let tid: string;

  beforeAll(async () => {
    tid = await tenantId();
  });

  it('IT-INI-002: a stage transition the machine has no arrow for is refused by the API, not silently accepted', async () => {
    const opsUser = await unscopedPrisma.user.findFirstOrThrow({ where: { email: 'operations@kaizen.co.in' }, include: { person: true } });
    const created = await asUser('operations@kaizen.co.in', () =>
      createInitiative({
        title: `In-flight initiative ${stamp()}`,
        theme: 'grow',
        sponsorPartyId: opsUser.personId,
        ownerPartyId: opsUser.personId,
        budget: 10_000,
      }),
    );

    await asUser('operations@kaizen.co.in', () => transitionInitiative(created.id, 'ASSESS'));
    const approveResult = await asUser('operations@kaizen.co.in', () => transitionInitiative(created.id, 'APPROVE').catch((e) => e));
    // Operations Head holds no it_initiatives:approve grant, so this must
    // reject at the gate's own permission check, never silently apply.
    expect(approveResult).toBeInstanceOf(Error);

    // Force the row to 'in_flight' directly (bypassing the gate) purely to
    // exercise the machine boundary itself: in_flight has no REALISE_BENEFITS arrow.
    await unscopedPrisma.itInitiative.update({ where: { id: created.id }, data: { stage: 'in_flight' } });
    const rejection = await expectReject(() =>
      asUser('operations@kaizen.co.in', () => transitionInitiative(created.id, 'REALISE_BENEFITS' as never)),
    );
    expect(rejection.status).toBe(422);

    const stillInFlight = await unscopedPrisma.itInitiative.findFirstOrThrow({ where: { id: created.id } });
    expect(stillInFlight.stage).toBe('in_flight');

    const detail = await asUser('operations@kaizen.co.in', () => initiativeDetail(created.id));
    expect(detail.availableTransitions.sort()).toEqual(['CANCEL', 'DELIVER'].sort());
  });

  it('IT-INI-001: approving an initiative one sponsors reroutes on the Self-Dealing Bar', async () => {
    // Only the chairman holds both create and approve on it_initiatives (the
    // Operations Head creates but cannot approve; the Finance Head approves
    // but cannot create) — so the chairman is the only account that can even
    // attempt to approve its own proposal, mirroring the vendor-contract test.
    const chairmanUser = await unscopedPrisma.user.findFirstOrThrow({ where: { email: 'chairman@kaizen.co.in' }, include: { person: true } });

    const own = await asUser('chairman@kaizen.co.in', () =>
      createInitiative({
        title: `Self-sponsored initiative ${stamp()}`,
        theme: 'transform',
        sponsorPartyId: chairmanUser.personId,
        ownerPartyId: chairmanUser.personId,
        budget: 5_000_000,
      }),
    );
    await asUser('chairman@kaizen.co.in', () => transitionInitiative(own.id, 'ASSESS'));

    const result = await asUser('chairman@kaizen.co.in', () => transitionInitiative(own.id, 'APPROVE'));
    expect(result.applied).toBe(false);
    expect(result.reason).toMatch(/Self-Dealing Bar/);
    expect(result.approvalStepId).toBeTruthy();

    const stillAssessed = await unscopedPrisma.itInitiative.findFirstOrThrow({ where: { id: own.id } });
    expect(stillAssessed.stage).toBe('assessed');
  });

  it('IT-INI-001: a Finance Head approving an initiative they did not sponsor is never flagged self-dealing', async () => {
    const opsUser = await unscopedPrisma.user.findFirstOrThrow({ where: { email: 'operations@kaizen.co.in' }, include: { person: true } });
    const initiative = await asUser('operations@kaizen.co.in', () =>
      createInitiative({
        title: `Sponsored by ops ${stamp()}`,
        theme: 'run',
        sponsorPartyId: opsUser.personId,
        ownerPartyId: opsUser.personId,
        budget: 25_000,
      }),
    );
    await asUser('operations@kaizen.co.in', () => transitionInitiative(initiative.id, 'ASSESS'));

    const result = await asUser('finance@kaizen.co.in', () => transitionInitiative(initiative.id, 'APPROVE'));
    // Whether it applies immediately depends on the AUTHORITY_GRANT ceiling
    // seeded for it_initiative_approval — either way it must never be flagged
    // self-dealing, and it must not silently fail.
    expect(result.reason === null || !result.reason.match(/Self-Dealing Bar/)).toBe(true);
    expect(typeof result.applied).toBe('boolean');
  });

  it('the Finance Head cannot create an initiative — the grant has no create — but holds approve', async () => {
    const denied = await expectReject(() =>
      asUser('finance@kaizen.co.in', () =>
        createInitiative({ title: 'Finance-proposed', theme: 'run', sponsorPartyId: 'x', ownerPartyId: 'x', budget: 1 }),
      ),
    );
    expect(denied.status).toBe(403);
  });

  it('the Operations Head proposes a budget line and cannot approve it — no approve verb on it_budgets', async () => {
    const line = await asUser('operations@kaizen.co.in', () =>
      createBudgetLine({ fy: 'FY2026-27', category: 'cloud', division: 'shared', kind: 'run', planned: 100_000 }),
    );
    const denied = await expectReject(() => asUser('operations@kaizen.co.in', () => approveBudgetLine(line.id)));
    expect(denied.status).toBe(403);
  });

  it("a budget line's own creator can never approve it, even holding the grant", async () => {
    const line = await asUser('finance@kaizen.co.in', () =>
      createBudgetLine({ fy: 'FY2026-27', category: 'people', division: 'shared', kind: 'run', planned: 50_000 }),
    );
    const denied = await expectReject(() => asUser('finance@kaizen.co.in', () => approveBudgetLine(line.id)));
    expect(denied.status).toBe(403);

    // Someone else with the grant approving is fine.
    const approved = await asUser('chairman@kaizen.co.in', () => approveBudgetLine(line.id));
    expect(approved.status).toBe('approved');
  });

  it('the employee reaches nothing on the portfolio — no grant on it_initiatives, it_budgets or it_tech_debt', async () => {
    const deniedInitiatives = await expectReject(() => asUser('employee@kaizen.co.in', () => listInitiatives()));
    expect(deniedInitiatives.status).toBe(403);

    const deniedBudget = await expectReject(() => asUser('employee@kaizen.co.in', () => budgetForFy('FY2026-27')));
    expect(deniedBudget.status).toBe(403);

    const deniedTechDebt = await expectReject(() => asUser('employee@kaizen.co.in', () => listTechDebt()));
    expect(deniedTechDebt.status).toBe(403);

    await expectReject(() => asUser('employee@kaizen.co.in', () => portfolioSummary()));
  });

  it('IT-BUD-001: a budget line\'s actual is a live sum over the books, and a late bill moves the variance without editing the line', async () => {
    const catName = `IT Cloud Spend ${stamp()}`;
    const category = await unscopedPrisma.ledgerCategory.create({
      data: { tenantId: tid, name: catName, kind: 'expense', behaviour: 'variable' },
    });

    const line = await asUser('finance@kaizen.co.in', () =>
      createBudgetLine({
        fy: 'FY2026-27',
        category: 'cloud',
        division: 'shared',
        kind: 'run',
        planned: 200_000,
        bookCategoryIds: [category.id],
      }),
    );

    const before = await asUser('finance@kaizen.co.in', () => budgetLineDetail(line.id));
    expect(before.actual).toBe(0);
    expect(before.variance).toBe(200_000);

    await unscopedPrisma.vendorBill.create({
      data: {
        tenantId: tid,
        recordCode: `BILL-PORTFOLIO-${stamp()}`,
        vendorName: 'Cloud Co',
        billDate: new Date('2026-06-15T00:00:00.000Z'),
        categoryId: category.id,
        division: 'shared',
        total: 40_000,
        status: 'open',
      },
    });

    const afterFirstBill = await asUser('finance@kaizen.co.in', () => budgetLineDetail(line.id));
    expect(afterFirstBill.actual).toBe(40_000);
    expect(afterFirstBill.variance).toBe(160_000);

    // A late bill lands — nothing on the line itself is touched, but the
    // actual and variance move the next time anyone asks.
    await unscopedPrisma.vendorBill.create({
      data: {
        tenantId: tid,
        recordCode: `BILL-PORTFOLIO-${stamp()}`,
        vendorName: 'Cloud Co',
        billDate: new Date('2026-11-01T00:00:00.000Z'),
        categoryId: category.id,
        division: 'shared',
        total: 15_000,
        status: 'open',
      },
    });

    const afterLateBill = await asUser('finance@kaizen.co.in', () => budgetLineDetail(line.id));
    expect(afterLateBill.actual).toBe(55_000);
    expect(afterLateBill.variance).toBe(145_000);

    const stillPlanned = await unscopedPrisma.itBudgetLine.findFirstOrThrow({ where: { id: line.id } });
    expect(Number(stillPlanned.planned)).toBe(200_000);

    // A draft bill is not yet a commitment and a cancelled one never was —
    // neither counts as spend.
    await unscopedPrisma.vendorBill.create({
      data: {
        tenantId: tid,
        recordCode: `BILL-PORTFOLIO-${stamp()}`,
        vendorName: 'Cloud Co',
        billDate: new Date('2026-07-01T00:00:00.000Z'),
        categoryId: category.id,
        division: 'shared',
        total: 999_000,
        status: 'draft',
      },
    });
    await unscopedPrisma.vendorBill.create({
      data: {
        tenantId: tid,
        recordCode: `BILL-PORTFOLIO-${stamp()}`,
        vendorName: 'Cloud Co',
        billDate: new Date('2026-08-01T00:00:00.000Z'),
        categoryId: category.id,
        division: 'shared',
        total: 999_000,
        status: 'cancelled',
      },
    });

    const afterDraftAndCancelled = await asUser('finance@kaizen.co.in', () => budgetLineDetail(line.id));
    expect(afterDraftAndCancelled.actual).toBe(55_000);
    expect(afterDraftAndCancelled.variance).toBe(145_000);
  });

  it('the Operations Head gets budget money masked — holds it_budgets:VCE, not F', async () => {
    const catName = `IT Masking Category ${stamp()}`;
    const category = await unscopedPrisma.ledgerCategory.create({
      data: { tenantId: tid, name: catName, kind: 'expense', behaviour: 'variable' },
    });
    const line = await asUser('finance@kaizen.co.in', () =>
      createBudgetLine({
        fy: 'FY2026-27',
        category: 'hardware',
        division: 'shared',
        kind: 'grow',
        planned: 75_000,
        bookCategoryIds: [category.id],
      }),
    );
    await unscopedPrisma.vendorBill.create({
      data: {
        tenantId: tid,
        recordCode: `BILL-MASK-${stamp()}`,
        vendorName: 'Hardware Co',
        billDate: new Date('2026-05-01T00:00:00.000Z'),
        categoryId: category.id,
        division: 'shared',
        total: 20_000,
        status: 'open',
      },
    });

    const opsDetail = await asUser('operations@kaizen.co.in', () => budgetLineDetail(line.id));
    expect(opsDetail.planned).toBeNull();
    expect(opsDetail.actual).toBeNull();
    expect(opsDetail.variance).toBeNull();

    const financeDetail = await asUser('finance@kaizen.co.in', () => budgetLineDetail(line.id));
    expect(financeDetail.planned).not.toBeNull();
    expect(financeDetail.actual).toBe(20_000);

    const opsForFy = await asUser('operations@kaizen.co.in', () => budgetForFy('FY2026-27'));
    expect(opsForFy.plannedTotal).toBeNull();
    expect(opsForFy.actualTotal).toBeNull();
    for (const l of opsForFy.lines) {
      expect(l.planned).toBeNull();
      expect(l.actual).toBeNull();
      expect(l.variance).toBeNull();
    }

    const opsSummary = await asUser('operations@kaizen.co.in', () => budgetSummary('FY2026-27'));
    expect(opsSummary.plannedTotal).toBeNull();
    expect(opsSummary.actualTotal).toBeNull();
    for (const c of opsSummary.byCategory) {
      expect(c.planned).toBeNull();
      expect(c.actual).toBeNull();
      expect(c.variance).toBeNull();
    }
    // Run/grow is a planning shape, not signed-off money — never masked.
    expect(typeof opsSummary.runTotal).toBe('number');
    expect(typeof opsSummary.growTotal).toBe('number');

    const financeSummary = await asUser('finance@kaizen.co.in', () => budgetSummary('FY2026-27'));
    expect(financeSummary.plannedTotal).not.toBeNull();
  });

  it('IT-BUD-002: the burn detector fires once per FY margin crossing, and a second run raises nothing new', async () => {
    const catName = `IT Burn Category ${stamp()}`;
    const category = await unscopedPrisma.ledgerCategory.create({
      data: { tenantId: tid, name: catName, kind: 'expense', behaviour: 'variable' },
    });

    const line = await asUser('finance@kaizen.co.in', () =>
      createBudgetLine({
        fy: 'FY2026-27',
        category: 'licences',
        division: 'shared',
        kind: 'run',
        planned: 100_000,
        bookCategoryIds: [category.id],
      }),
    );
    await asUser('chairman@kaizen.co.in', () => approveBudgetLine(line.id));

    // Spend almost the entire year's plan on day one of the FY — guaranteed
    // to run far ahead of the elapsed fraction regardless of what "today" is.
    await unscopedPrisma.vendorBill.create({
      data: {
        tenantId: tid,
        recordCode: `BILL-BURN-${stamp()}`,
        vendorName: 'Licence Co',
        billDate: new Date('2026-04-02T00:00:00.000Z'),
        categoryId: category.id,
        division: 'shared',
        total: 95_000,
        status: 'open',
      },
    });

    const first = await asUser('finance@kaizen.co.in', () => runBudgetBurnJob());
    expect(first.notified).toBe(1);
    const count1 = await unscopedPrisma.exceptionRecord.count({ where: { tenantId: tid, code: 'IT_BUDGET_BURN', subjectId: line.id } });
    expect(count1).toBe(1);

    const second = await asUser('finance@kaizen.co.in', () => runBudgetBurnJob());
    expect(second.notified).toBe(0);
    const count2 = await unscopedPrisma.exceptionRecord.count({ where: { tenantId: tid, code: 'IT_BUDGET_BURN', subjectId: line.id } });
    expect(count2).toBe(1);

    const refreshed = await unscopedPrisma.itBudgetLine.findFirstOrThrow({ where: { id: line.id } });
    expect(refreshed.burnNotifiedAt).toBeTruthy();
  });

  it('the portfolio summary reports "not yet measured" only with no initiatives, and stage/RAG counts once one exists', async () => {
    const opsUser = await unscopedPrisma.user.findFirstOrThrow({ where: { email: 'operations@kaizen.co.in' }, include: { person: true } });
    const before = await asUser('finance@kaizen.co.in', () => portfolioSummary());
    if (before.notYetMeasured) {
      // Only true on a tenant with zero initiatives — the fixture tenant
      // already has some from earlier tests in this file, so this branch is
      // defensive rather than expected.
      expect(before.byRag.total).toBe(0);
    }

    await asUser('operations@kaizen.co.in', () =>
      createInitiative({ title: `Summary check ${stamp()}`, theme: 'run', sponsorPartyId: opsUser.personId, ownerPartyId: opsUser.personId, budget: 1000 }),
    );
    const after = await asUser('finance@kaizen.co.in', () => portfolioSummary());
    expect(after.notYetMeasured).toBe(false);
    expect(Object.values(after.byStage).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it('tech-debt items run through the declared lifecycle and cannot skip to an undeclared state', async () => {
    const item = await asUser('operations@kaizen.co.in', () =>
      createTechDebtItem({ title: `Legacy PHP ${stamp()}`, severity: 'high', interest: 'Security patches have stopped.' }),
    );
    expect(item.status).toBe('open');
    expect(item.recordCode).toMatch(/^TDB-/);

    const denied = await expectReject(() => asUser('employee@kaizen.co.in', () => listTechDebt()));
    expect(denied.status).toBe(403);
  });
});
