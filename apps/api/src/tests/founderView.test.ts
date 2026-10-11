/**
 * The founder exception view (OP:120; SPINE-CONTRACT 1.6; OPUS decision 11).
 *
 * A read model, with no table of its own. It is a union of five sources: open
 * exceptions, commitments that are missed or overdue, decisions awaiting a
 * disposition, approval steps still pending, and open cases past their response
 * due. Each property below is one the view must keep:
 *   - every row names its source, its record, a drillTo that is a real route on
 *     main, and a timestamp; an escalation rung is reported where the source has one;
 *   - each source reports one of three states: measured with n rows, not measured
 *     (the table is missing from the database), or withheld (the caller lacks view).
 *     A missing table is never zero; a table with no rows is zero;
 *   - only the chairman holds founder_view, and a principal without it gets 403;
 *   - rows of another tenant never appear, in either direction.
 *
 * Real Postgres and real contexts, no mocks. The "missing table" case swaps one
 * source's physical table name for one that does not exist; the read model's own
 * existence check then runs against the real database and refuses to query it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROLE_GRANT_MATRIX, ALL_RESOURCES } from '../seed/grants.js';
import { addMissingGrants } from '../platform/grantSync.js';
import {
  asPrincipal,
  asUser,
  authFor,
  principalFor,
  sessionToken,
  tenantId,
  unscopedPrisma,
  withFixtureRole,
} from './helpers.js';
import { createApp } from '../server.js';
import { proposeCommitment, confirmCommitment, markCommitmentMissed } from '../domains/commitments.js';
import { openCase } from '../domains/cases.js';
import { raiseDecision } from '../domains/decisions.js';
import { raiseException } from '../platform/exceptions.js';
import type { Server } from 'node:http';

const CHAIRMAN = 'chairman@kaizen.co.in';
const NON_FOUNDER = 'controller@kaizen.co.in';
const DAY = 86_400_000;

function uniq(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function personIn(tid: string): Promise<string> {
  const email = `fv-${uniq()}@fv.test`;
  const row = await unscopedPrisma.person.create({
    data: {
      tenantId: tid,
      recordCode: `PER-FV-${uniq().toUpperCase()}`,
      fullName: 'Founder view party',
      primaryEmail: email,
      primaryEmailNormalised: email,
      source: 'test',
    },
  });
  return row.id;
}

/**
 * A tenant of its own, holding founder_view and the five source views, with no
 * rows in any source. Built the way commitments.test builds its second tenant.
 */
async function emptyTenantFounder() {
  const slug = `fv-empty-${uniq()}`;
  const tenant = await unscopedPrisma.tenant.create({ data: { name: `Founder view ${slug}`, slug } });
  const role = await unscopedPrisma.accessRole.create({
    data: {
      tenantId: tenant.id,
      slug,
      name: `Founder view fixture ${slug}`,
      description: 'Created by founderView.test. Not a product role.',
      archetype: 'workspace',
      classificationCeiling: 'regulated',
      isSystem: false,
    },
  });
  for (const resource of ['founder_view', 'exceptions', 'commitments', 'decisions', 'approval_steps', 'cases']) {
    await unscopedPrisma.grant.create({
      data: {
        tenantId: tenant.id,
        principalType: 'role',
        roleId: role.id,
        resource,
        verbs: ['view'],
        scope: 'all',
        scopeResolver: null,
      },
    });
  }
  const email = `${slug}@fv.test`;
  const person = await unscopedPrisma.person.create({
    data: {
      tenantId: tenant.id,
      recordCode: `PER-${slug.toUpperCase()}`,
      fullName: slug,
      primaryEmail: email,
      primaryEmailNormalised: email,
      source: 'test',
    },
  });
  const affiliation = await unscopedPrisma.affiliation.create({
    data: {
      tenantId: tenant.id,
      partyId: person.id,
      affiliationType: 'employee',
      counterpartyName: 'Fixture',
      roleSlug: slug,
      primaryFlag: true,
      status: 'active',
      branch: 'Chennai',
    },
  });
  const user = await unscopedPrisma.user.create({
    data: { tenantId: tenant.id, personId: person.id, email, passwordHash: 'not-a-login', branch: 'Chennai' },
  });
  return {
    tenantId: tenant.id,
    partyId: person.id,
    userId: user.id,
    affiliationId: affiliation.id,
    roleSlug: slug,
    branch: 'Chennai',
  };
}

let KAIZEN: string;

beforeAll(async () => {
  KAIZEN = await tenantId('kaizen');
  // The production boot path: a role that has no row for a resource the matrix
  // declares gets the row. The test database was loaded before founder_view existed.
  await addMissingGrants(KAIZEN);
});

describe('FV-001 — the chairman, and only the chairman, holds founder_view in the matrix', () => {
  it('ALL_RESOURCES names founder_view, so the chairman row is generated with it', () => {
    expect(ALL_RESOURCES as readonly string[]).toContain('founder_view');
  });

  it('no role other than the chairman is granted founder_view', () => {
    const holders = Object.entries(ROLE_GRANT_MATRIX)
      .filter(([, specs]) => specs.some((s) => s.resource === 'founder_view'))
      .map(([slug]) => slug);
    expect(holders).toEqual(['chairman']);
  });
});

describe('FV-002 — rows from each source appear, each with its drillTo', () => {
  const ids: Record<string, string> = {};
  let proposedId: string;
  let approvedStepId: string;

  beforeAll(async () => {
    const owner = await personIn(KAIZEN);
    await asUser(CHAIRMAN, async () => {
      const exception = await raiseException({
        code: 'FV_TEST_EXCEPTION',
        label: 'Founder view test exception',
        severity: 'S2_WARNING',
        subjectType: 'mou',
        subjectId: `subject-${uniq()}`,
        detail: 'Raised by founderView.test',
        ownerPartyId: owner,
        notify: false,
      });
      ids.exception = exception.id;

      const commitment = await proposeCommitment({
        title: 'Founder view test commitment',
        ownerPartyId: owner,
        backupPartyId: null,
        nextAction: 'Ring back',
        dueAt: new Date(Date.now() + 7 * DAY),
        sourceType: 'manual',
        subjectType: 'mou',
        subjectId: `subject-${uniq()}`,
      });
      await confirmCommitment(commitment.id);
      // Confirmed and past its due instant: overdue, though the job has not run.
      await unscopedPrisma.commitment.update({
        where: { id: commitment.id },
        data: { dueAt: new Date(Date.now() - DAY) },
      });
      ids.commitment = commitment.id;

      const missed = await proposeCommitment({
        title: 'Founder view test missed commitment',
        ownerPartyId: owner,
        backupPartyId: null,
        nextAction: null,
        dueAt: new Date(Date.now() + 7 * DAY),
        sourceType: 'manual',
        subjectType: 'mou',
        subjectId: `subject-${uniq()}`,
      });
      await confirmCommitment(missed.id);
      await markCommitmentMissed(missed.id);
      ids.missedCommitment = missed.id;

      const proposed = await proposeCommitment({
        title: 'Founder view test proposal',
        ownerPartyId: owner,
        backupPartyId: null,
        nextAction: null,
        dueAt: new Date(Date.now() - DAY),
        sourceType: 'agent',
        subjectType: 'mou',
        subjectId: `subject-${uniq()}`,
      });
      proposedId = proposed.id;

      const decision = await raiseDecision({
        question: 'Founder view test decision',
        subjectType: 'mou',
        subjectId: `subject-${uniq()}`,
        authorityBasis: 'founder_view.test',
        requiredAuthorityValue: null,
        routedToRole: 'chairman',
      });
      ids.decision = decision.id;

      const kase = await openCase({
        kind: 'customer',
        title: 'Founder view test case',
        ownerPartyId: owner,
        backupPartyId: null,
        responseDueAt: new Date(Date.now() + 7 * DAY),
        visibilityTier: 'internal',
        severity: 'S2_WARNING',
      });
      await unscopedPrisma.case.update({
        where: { id: kase.id },
        data: { responseDueAt: new Date(Date.now() - DAY) },
      });
      ids.case = kase.id;
    });

    const step = await unscopedPrisma.approvalStep.create({
      data: {
        tenantId: KAIZEN,
        subjectType: 'mou',
        subjectId: `subject-${uniq()}`,
        subjectLabel: 'Founder view test MoU',
        action: 'mou.approve',
        requestedById: owner,
        state: 'open',
        escalationRung: 2,
      },
    });
    ids.approval = step.id;

    const settled = await unscopedPrisma.approvalStep.create({
      data: {
        tenantId: KAIZEN,
        subjectType: 'mou',
        subjectId: `subject-${uniq()}`,
        action: 'mou.approve',
        requestedById: owner,
        state: 'approved',
      },
    });
    approvedStepId = settled.id;
  });

  it('each source contributes its row, with the drillTo the web app serves', async () => {
    const { founderView } = await import('../domains/founderView.js');
    const view = await asUser(CHAIRMAN, async () => founderView());
    const byId = new Map(view.rows.map((r) => [r.sourceId, r]));

    expect(byId.get(ids.exception)?.sourceKind).toBe('exception');
    expect(byId.get(ids.exception)?.drillTo).toBe(`/exceptions/${ids.exception}`);
    // A founder reads a name, not a cuid. The owner's name comes from the same tenant.
    expect(byId.get(ids.exception)?.ownerName).toBe('Founder view party');

    expect(byId.get(ids.commitment)?.sourceKind).toBe('commitment');
    expect(byId.get(ids.commitment)?.drillTo).toBe('/admin/events');
    expect(byId.get(ids.missedCommitment)?.state).toBe('missed');

    expect(byId.get(ids.decision)?.sourceKind).toBe('decision');
    expect(byId.get(ids.decision)?.drillTo).toBe('/command/decisions');

    expect(byId.get(ids.approval)?.sourceKind).toBe('approval_step');
    expect(byId.get(ids.approval)?.drillTo).toBe(`/approvals/${ids.approval}`);
    expect(byId.get(ids.approval)?.escalationRung).toBe(2);

    expect(byId.get(ids.case)?.sourceKind).toBe('case');
    expect(byId.get(ids.case)?.drillTo).toBe('/admin/events');
  });

  it('every row carries a timestamp and a record code or null, never a blank', async () => {
    const { founderView } = await import('../domains/founderView.js');
    const view = await asUser(CHAIRMAN, async () => founderView());
    for (const row of view.rows) {
      expect(Number.isNaN(Date.parse(row.timestamp)), `bad timestamp on ${row.sourceKind}`).toBe(false);
      expect(row.title.length, `blank title on ${row.sourceKind}`).toBeGreaterThan(0);
    }
  });

  it('the proposal and the settled approval do not appear, because neither is open', async () => {
    const { founderView } = await import('../domains/founderView.js');
    const view = await asUser(CHAIRMAN, async () => founderView());
    const sourceIds = new Set(view.rows.map((r) => r.sourceId));
    expect(sourceIds.has(proposedId)).toBe(false);
    expect(sourceIds.has(approvedStepId)).toBe(false);
  });

  it('every source reports measured with at least the rows created here', async () => {
    const { founderView } = await import('../domains/founderView.js');
    const view = await asUser(CHAIRMAN, async () => founderView());
    for (const kind of ['exception', 'commitment', 'decision', 'approval_step', 'case'] as const) {
      const s = view.sources[kind];
      expect(s.status, kind).toBe('measured');
      if (s.status === 'measured') expect(s.count, kind).toBeGreaterThan(0);
    }
  });
});

describe('FV-003 — empty is zero; a missing table is not measured; a withheld source is withheld', () => {
  it('a tenant with tables and no rows reports every source as measured with zero', async () => {
    const { founderView } = await import('../domains/founderView.js');
    const p = await emptyTenantFounder();
    const view = await asPrincipal(authFor(p), async () => founderView());
    expect(view.rows).toEqual([]);
    for (const kind of ['exception', 'commitment', 'decision', 'approval_step', 'case'] as const) {
      expect(view.sources[kind], kind).toEqual({ status: 'measured', count: 0, shown: 0 });
    }
  });

  it('a source whose table is absent is not measured, and is not reported as zero', async () => {
    const { founderView, FOUNDER_SOURCES } = await import('../domains/founderView.js');
    const withMissingTable = FOUNDER_SOURCES.map((s) =>
      s.kind === 'commitment' ? { ...s, table: 'founder_view_fixture_table_that_does_not_exist' } : s,
    );
    const view = await asUser(CHAIRMAN, async () => founderView(withMissingTable));
    expect(view.sources.commitment.status).toBe('not_measured');
    expect(view.sources.commitment).not.toHaveProperty('count');
    expect(view.sources.exception.status).toBe('measured');
    expect(view.rows.some((r) => r.sourceKind === 'commitment')).toBe(false);
  });

  it('a source the caller cannot view is withheld, with no count, while the others stay measured', async () => {
    const { founderView } = await import('../domains/founderView.js');
    await withFixtureRole(
      {
        slug: 'fv_partial',
        grants: [
          { resource: 'founder_view', verbs: ['view'] },
          { resource: 'exceptions', verbs: ['view'] },
        ],
      },
      async () => {
        const view = await founderView();
        expect(view.sources.commitment.status).toBe('withheld');
        expect(view.sources.commitment).not.toHaveProperty('count');
        expect(view.sources.exception.status).toBe('measured');
        expect(view.rows.some((r) => r.sourceKind === 'commitment')).toBe(false);
      },
    );
  });
});

describe('FV-004 — a principal without founder_view is refused at the route', () => {
  let server: Server;
  let base: string;

  beforeAll(() => {
    server = createApp().listen(0);
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    base = `http://127.0.0.1:${port}/api`;
  });

  afterAll(() => {
    server?.close();
  });

  async function tokenFor(email: string): Promise<string> {
    const p = await principalFor(email);
    return sessionToken({ userId: p.userId, tenantId: p.tenantId, affiliationId: p.affiliationId, stepUp: true });
  }

  it('a finance head gets 403, and no body of rows', async () => {
    const token = await tokenFor(NON_FOUNDER);
    const res = await fetch(`${base}/command/founder-view`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('rows');
    expect(body).not.toHaveProperty('sources');
  });

  it('the chairman gets 200 with the sources and rows', async () => {
    const token = await tokenFor(CHAIRMAN);
    const res = await fetch(`${base}/command/founder-view`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sources: Record<string, { status: string }>; rows: unknown[] };
    expect(Object.keys(body.sources).sort()).toEqual(['approval_step', 'case', 'commitment', 'decision', 'exception']);
    expect(Array.isArray(body.rows)).toBe(true);
  });
});

describe('FV-005 — another tenant’s rows never appear', () => {
  it('a commitment and an exception in another tenant are absent from the chairman’s view, and the other tenant sees only its own', async () => {
    const { founderView } = await import('../domains/founderView.js');
    const other = await emptyTenantFounder();
    const otherOwner = await unscopedPrisma.person.findFirstOrThrow({ where: { id: other.partyId } });

    const foreignCommitment = await unscopedPrisma.commitment.create({
      data: {
        tenantId: other.tenantId,
        recordCode: `CMT-FV-${uniq().toUpperCase()}`,
        title: 'Foreign commitment',
        ownerPartyId: otherOwner.id,
        dueAt: new Date(Date.now() - DAY),
        state: 'missed',
        // The check constraint refuses a confirmed or later state without its confirmer.
        confirmedById: otherOwner.id,
        confirmedAt: new Date(Date.now() - 2 * DAY),
        sourceType: 'manual',
        subjectType: 'mou',
        subjectId: 'foreign',
      },
    });
    const foreignException = await unscopedPrisma.exceptionRecord.create({
      data: {
        tenantId: other.tenantId,
        recordCode: `EXC-FV-${uniq().toUpperCase()}`,
        code: 'FV_FOREIGN',
        label: 'Foreign exception',
        severity: 'S3_HIGH_RISK',
        subjectType: 'mou',
        subjectId: 'foreign',
        ownerPartyId: otherOwner.id,
      },
    });

    const chairmanView = await asUser(CHAIRMAN, async () => founderView());
    const chairmanIds = new Set(chairmanView.rows.map((r) => r.sourceId));
    expect(chairmanIds.has(foreignCommitment.id)).toBe(false);
    expect(chairmanIds.has(foreignException.id)).toBe(false);

    const otherView = await asPrincipal(authFor(other), async () => founderView());
    const otherIds = new Set(otherView.rows.map((r) => r.sourceId));
    expect(otherIds.has(foreignCommitment.id)).toBe(true);
    expect(otherIds.has(foreignException.id)).toBe(true);
    for (const row of otherView.rows) {
      expect(chairmanIds.has(row.sourceId), `tenant B saw a tenant A row ${row.sourceId}`).toBe(false);
    }
  });
});
