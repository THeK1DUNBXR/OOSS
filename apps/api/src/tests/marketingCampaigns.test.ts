/**
 * Marketing — campaigns & budget (MKT-CMP-*, MKT-BUD-*).
 *
 * DB-backed, following the same pattern as acceptance.test.ts and the other
 * marketing suites: real request context, real permission evaluation, real
 * event chain — nothing mocked.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { asUser, expectReject, tenantId, unscopedPrisma } from './helpers.js';
import { asSystem } from '../platform/context.js';
import {
  createCampaign,
  updateCampaign,
  deleteCampaign,
  getCampaign,
  submitCampaign,
  approveCampaign,
  rejectCampaign,
  launchCampaign,
  pauseCampaign,
  resumeCampaign,
  completeCampaign,
  cancelCampaign,
  type CampaignCreateInput,
} from '../domains/marketing/campaigns.js';
import { createBudget, recordSpend, reconcileSpend, budgetVariance, detectOverBudget } from '../domains/marketing/budget.js';

let TENANT: string;

beforeAll(async () => {
  TENANT = await tenantId();
});

const CHAIRMAN = 'chairman@kaizen.co.in';
const FINANCE = 'finance@kaizen.co.in';
const OPERATIONS = 'operations@kaizen.co.in';

function campaignInput(overrides: Partial<CampaignCreateInput> = {}): CampaignCreateInput {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
  return {
    name: `Test campaign ${stamp}`,
    objective: 'lead_gen',
    division: 'software',
    channelMix: ['email'],
    startAt: new Date(),
    endAt: new Date(Date.now() + 30 * 86_400_000),
    budgetPlanned: 10_000,
    ...overrides,
  };
}

// ===========================================================================
// MKT-CMP-001/002 — create, submit below/above threshold
// ===========================================================================

describe('MKT-CMP-001 — a campaign is created in draft', () => {
  it('starts in draft with the fields it was given', async () => {
    await asUser(OPERATIONS, async () => {
      const campaign = await createCampaign(campaignInput({ name: 'Draft campaign' }));
      expect(campaign.status).toBe('draft');
      expect(campaign.name).toBe('Draft campaign');
      expect(campaign.approvalRequired).toBe(false);
      expect(campaign.budgetActual).toBe(0);
    });
  });
});

describe('MKT-CMP-002 — submit resolves scheduled or pending_approval by threshold', () => {
  it('a campaign below the approval threshold is scheduled directly on submit', async () => {
    await asUser(OPERATIONS, async () => {
      const created = await createCampaign(campaignInput({ budgetPlanned: 1_000 }));
      const submitted = await submitCampaign(created.id);
      expect(submitted.status).toBe('scheduled');
      expect(submitted.approvalRequired).toBe(false);
      expect(submitted.approvals.length).toBe(0);
    });
  });

  it('a campaign above the approval threshold cannot be scheduled without approval', async () => {
    await asUser(OPERATIONS, async () => {
      const created = await createCampaign(campaignInput({ budgetPlanned: 60_000 }));
      const submitted = await submitCampaign(created.id);
      expect(submitted.status).toBe('pending_approval');
      expect(submitted.approvalRequired).toBe(true);
      expect(submitted.approvals.length).toBe(1);
      expect(submitted.approvals[0].decision).toBe('pending');
    });
  });
});

// ===========================================================================
// MKT-CMP-003, MKT-GOV-004 — the Self-Dealing Bar
// ===========================================================================

describe("MKT-CMP-003 — a campaign's proposer never approves it, even the chairman", () => {
  it('the operations head cannot approve their own submitted campaign', async () => {
    const campaignId = await asUser(OPERATIONS, async () => {
      const created = await createCampaign(campaignInput({ budgetPlanned: 60_000 }));
      const submitted = await submitCampaign(created.id);
      return submitted.id;
    });

    await asUser(OPERATIONS, async () => {
      const err = await expectReject(() => approveCampaign(campaignId));
      expect(err.status).toBe(403);
    });

    const stillPending = await asSystem(TENANT, () => getCampaign(campaignId));
    expect(stillPending.status).toBe('pending_approval');
  });

  it('the chairman cannot approve a campaign they themselves proposed', async () => {
    const campaignId = await asUser(CHAIRMAN, async () => {
      const created = await createCampaign(campaignInput({ budgetPlanned: 60_000 }));
      const submitted = await submitCampaign(created.id);
      return submitted.id;
    });

    await asUser(CHAIRMAN, async () => {
      const err = await expectReject(() => approveCampaign(campaignId));
      expect(err.status).toBe(403);
      expect(err.message).toMatch(/self-dealing/i);
    });
  });
});

describe('MKT-CMP-003 — finance_head approves what it did not propose', () => {
  it('approves a pending campaign proposed by someone else, moving it to scheduled', async () => {
    const campaignId = await asUser(OPERATIONS, async () => {
      const created = await createCampaign(campaignInput({ budgetPlanned: 60_000 }));
      const submitted = await submitCampaign(created.id);
      return submitted.id;
    });

    await asUser(FINANCE, async () => {
      const approved = await approveCampaign(campaignId, 'Looks fine');
      expect(approved.status).toBe('scheduled');
      expect(approved.approvals[0].decision).toBe('approved');
      expect(approved.approvedById).toBeTruthy();
    });
  });

  it('finance_head can reject a pending campaign back to draft', async () => {
    const campaignId = await asUser(OPERATIONS, async () => {
      const created = await createCampaign(campaignInput({ budgetPlanned: 60_000 }));
      const submitted = await submitCampaign(created.id);
      return submitted.id;
    });

    await asUser(FINANCE, async () => {
      const rejected = await rejectCampaign(campaignId, 'Budget too high for this quarter');
      expect(rejected.status).toBe('draft');
      expect(rejected.approvals[0].decision).toBe('rejected');
    });
  });
});

// ===========================================================================
// MKT-CMP-004 — CAMPAIGN_TRANSITIONS is the only path
// ===========================================================================

describe('MKT-CMP-004 — only CAMPAIGN_TRANSITIONS-listed moves are accepted', () => {
  it('rejects launching a draft campaign (must be scheduled first)', async () => {
    await asUser(OPERATIONS, async () => {
      const created = await createCampaign(campaignInput());
      const err = await expectReject(() => launchCampaign(created.id));
      expect(err.status).toBe(409);
      expect(err.message).toMatch(/invalid transition/i);
    });
  });

  it('runs the full launch/pause/resume/complete lifecycle for a scheduled campaign', async () => {
    await asUser(OPERATIONS, async () => {
      const created = await createCampaign(campaignInput({ budgetPlanned: 1_000 }));
      const submitted = await submitCampaign(created.id);
      expect(submitted.status).toBe('scheduled');

      const live = await launchCampaign(created.id);
      expect(live.status).toBe('live');

      const paused = await pauseCampaign(created.id);
      expect(paused.status).toBe('paused');

      const resumed = await resumeCampaign(created.id);
      expect(resumed.status).toBe('live');

      const completed = await completeCampaign(created.id);
      expect(completed.status).toBe('completed');

      // Terminal: nothing further is a valid transition.
      const err = await expectReject(() => cancelCampaign(created.id, 'too late'));
      expect(err.status).toBe(409);
    });
  });
});

// ===========================================================================
// Delete — draft only
// ===========================================================================

describe('MKT-CMP — delete is draft-only, soft', () => {
  it('deletes a draft campaign', async () => {
    await asUser(OPERATIONS, async () => {
      const created = await createCampaign(campaignInput());
      const result = await deleteCampaign(created.id);
      expect(result.ok).toBe(true);
      const err = await expectReject(() => getCampaign(created.id));
      expect(err.status).toBe(404);
    });
  });

  it('refuses to delete a campaign that has left draft', async () => {
    await asUser(OPERATIONS, async () => {
      const created = await createCampaign(campaignInput({ budgetPlanned: 1_000 }));
      await submitCampaign(created.id);
      const err = await expectReject(() => deleteCampaign(created.id));
      expect(err.status).toBe(409);
    });
  });
});

// ===========================================================================
// updateCampaign — edit only while draft/paused/scheduled
// ===========================================================================

describe('MKT-CMP — a campaign is editable only while draft, paused or scheduled', () => {
  it('rejects editing a completed campaign', async () => {
    await asUser(OPERATIONS, async () => {
      const created = await createCampaign(campaignInput({ budgetPlanned: 1_000 }));
      await submitCampaign(created.id);
      await launchCampaign(created.id);
      await completeCampaign(created.id);
      const err = await expectReject(() => updateCampaign(created.id, { name: 'renamed' }));
      expect(err.status).toBe(409);
    });
  });

  it('allows editing a draft campaign', async () => {
    await asUser(OPERATIONS, async () => {
      const created = await createCampaign(campaignInput());
      const updated = await updateCampaign(created.id, { name: 'A better name', budgetPlanned: 20_000 });
      expect(updated.name).toBe('A better name');
      expect(updated.budgetPlanned).toBe(20_000);
    });
  });
});

// ===========================================================================
// Cross-tenant isolation
// ===========================================================================

describe('MKT-CMP — cross-tenant reach', () => {
  it('a campaign is not found from another tenant, by direct id', async () => {
    const campaignId = await asUser(OPERATIONS, async () => {
      const created = await createCampaign(campaignInput());
      return created.id;
    });

    const other = await unscopedPrisma.tenant.upsert({
      where: { slug: 'other-tenant' },
      create: { slug: 'other-tenant', name: 'Other Tenant' },
      update: {},
    });

    await asSystem(other.id, async () => {
      const err = await expectReject(() => getCampaign(campaignId));
      expect(err.status).toBe(404);
    });
  });
});

// ===========================================================================
// Budget & spend (MKT-BUD-*)
// ===========================================================================

describe('MKT-BUD-001 — budget variance is not measured without an approved budget', () => {
  it('a created-but-unapproved budget reports measured:false', async () => {
    const period = `2031-${String((Math.floor(Math.random() * 12) + 1)).padStart(2, '0')}`;
    const division = 'software';

    await asUser(OPERATIONS, async () => {
      await createBudget({ period, division, planned: 5_000 });
    });

    await asUser(FINANCE, async () => {
      const rows = await budgetVariance({ period, division });
      const row = rows.find((r) => r.division === division && r.planned === 5_000);
      expect(row).toBeDefined();
      expect(row?.measured).toBe(false);
    });
  });
});

describe('MKT-BUD-002 — spend exceeding the planned budget raises EX-MKT-002', () => {
  it('flags a campaign whose recorded spend exceeds budgetPlanned', async () => {
    const campaignId = await asUser(OPERATIONS, async () => {
      const created = await createCampaign(campaignInput({ budgetPlanned: 1_000 }));
      const submitted = await submitCampaign(created.id);
      await launchCampaign(created.id);
      return submitted.id;
    });

    await asUser(OPERATIONS, async () => {
      await recordSpend({
        campaignId,
        channelKey: 'email',
        division: 'software',
        amount: 2_500,
        spendDate: new Date(),
        description: 'Over-budget test spend',
      });
    });

    await asUser(OPERATIONS, async () => {
      const flagged = await detectOverBudget();
      expect(flagged).toBeGreaterThanOrEqual(1);
    });

    const exc = await unscopedPrisma.exceptionRecord.findFirst({
      where: { tenantId: TENANT, code: 'EX-MKT-002', subjectId: campaignId },
    });
    expect(exc).toBeTruthy();

    const campaign = await asSystem(TENANT, () => getCampaign(campaignId));
    expect(campaign.budgetActual).toBe(2_500);
    expect(campaign.spendTotal).toBe(2_500);
  });
});

describe('MKT-BUD-004 — spend reconciliation references an existing books row', () => {
  it('refuses to reconcile against an unknown transaction id', async () => {
    await asUser(OPERATIONS, async () => {
      const spend = await recordSpend({
        channelKey: 'email',
        division: 'software',
        amount: 500,
        spendDate: new Date(),
        description: 'Reconcile test spend',
      });

      const err = await expectReject(() => reconcileSpend(spend.id, { transactionId: 'not-a-real-transaction-id' }));
      expect(err.status).toBe(400);
    });
  });
});
