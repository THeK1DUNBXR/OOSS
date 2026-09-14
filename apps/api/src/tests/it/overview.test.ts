/**
 * Technology overview and the H_TEC health domain (docs/plan/cio.md, workstream I).
 *
 * IT-OVR-001: on an empty tenant every section of the composed overview
 * reports `notYetMeasured` (or `withheld`, for a role the grant matrix
 * narrows) — never a zero standing in for "nothing here yet" — and the
 * top-level flag follows.
 *
 * IT-HLT-001: `computeDomainHealth('H_TEC')` reports `not_yet_measured` with
 * no inputs; once a couple of tickets and incidents exist it reports
 * `measured`, and only the factors whose inputs actually exist are present.
 */

import { describe, expect, it } from 'vitest';
import { asUser, tenantId, unscopedPrisma } from '../helpers.js';
import { overview } from '../../domains/it/overview.js';
import { computeDomainHealth } from '../../domains/health.js';

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

describe('IT-OVR-001: the technology overview on the fixture tenant', () => {
  it('reports every section as not yet measured, withheld, or a genuine reading — never a zero standing in for unmeasured', async () => {
    const result = await asUser('chairman@kaizen.co.in', () => overview());

    // The fixture tenant carries no transactional IT rows at all — no
    // assets, tickets, incidents, changes, risks, findings, initiatives,
    // budget lines or continuity plans — so every one of those sections
    // must report not yet measured, not a zero.
    const asRecord = (s: unknown) => s as Record<string, unknown>;
    const shouldBeUnmeasured: Array<[string, Record<string, unknown>]> = [
      ['assets', asRecord(result.assets)],
      ['applications', asRecord(result.applications)],
      ['licences', asRecord(result.licences)],
      ['vendors', asRecord(result.vendors)],
      ['contracts', asRecord(result.contracts)],
      ['tickets', asRecord(result.tickets)],
      ['incidents', asRecord(result.incidents)],
      ['changes', asRecord(result.changes)],
      ['risks', asRecord(result.risks)],
      ['findings', asRecord(result.findings)],
      ['initiatives', asRecord(result.initiatives)],
      ['budget', asRecord(result.budget)],
      ['continuity', asRecord(result.continuity)],
      ['availability', asRecord(result.availability)],
    ];
    for (const [name, section] of shouldBeUnmeasured) {
      expect(section, name).toBeTruthy();
      expect(section.notYetMeasured, name).toBe(true);
      // Never withheld either: the chairman's row holds `V` on every
      // resource, so no section should read as access-denied.
      expect(section.withheld, name).toBeFalsy();
    }

    // Bootstrap seeds a handful of starter policy drafts (governance
    // reference data, not a transactional reading), so the policies
    // section is genuinely measured — a real count, not a stand-in zero:
    // `published` is honestly 0 because nothing has been published yet.
    const policies = asRecord(result.policies);
    expect(policies).toBeTruthy();
    expect(policies.withheld).toBeFalsy();
    if (policies.notYetMeasured !== true) {
      expect(policies.published).toBe(0);
      expect(policies.drafts).toBeGreaterThan(0);
      expect(policies.acknowledgementRate).toBeNull();
    }

    // The top-level flag is exactly the conjunction of every section's own
    // flag — never hand-set, never independently "true" while a section
    // underneath disagrees.
    const allSections = [...shouldBeUnmeasured.map(([, s]) => s), policies];
    const expectedTopLevel = allSections.every((s) => s.notYetMeasured === true || s.withheld === true);
    expect(result.notYetMeasured).toBe(expectedTopLevel);
    expect(result.notYetMeasured).toBe(false);
  });
});

describe('IT-HLT-001: H_TEC reports honestly', () => {
  it('is not yet measured with no inputs, then measured once tickets and incidents exist', async () => {
    const before = await asUser('chairman@kaizen.co.in', () => computeDomainHealth('H_TEC'));
    expect(before.state).toBe('not_yet_measured');
    expect(before.score).toBeNull();
    expect(before.factors).toHaveLength(0);

    const s = stamp();
    const tid = await tenantId();

    const requester = await unscopedPrisma.person.create({
      data: { tenantId: tid, recordCode: `PER-OVR-${s}`, fullName: `Overview Requester ${s}`, source: 'test' },
    });

    const now = new Date();
    const resolvedRecently = new Date(now.getTime() - 2 * 86_400_000);

    // Two tickets resolved inside the last 30 days: one inside its resolution
    // clock, one past it — a real, non-trivial SLA attainment reading.
    await unscopedPrisma.itTicket.create({
      data: {
        tenantId: tid,
        requesterPartyId: requester.id,
        category: 'incident',
        priority: 'P2',
        status: 'resolved',
        subject: `Overview SLA met ${s}`,
        description: 'Fixture ticket for IT-HLT-001',
        respondDueAt: new Date(resolvedRecently.getTime() - 3 * 3_600_000),
        resolveDueAt: new Date(resolvedRecently.getTime() + 3_600_000),
        resolvedAt: resolvedRecently,
      },
    });
    await unscopedPrisma.itTicket.create({
      data: {
        tenantId: tid,
        requesterPartyId: requester.id,
        category: 'incident',
        priority: 'P1',
        status: 'resolved',
        subject: `Overview SLA breached ${s}`,
        description: 'Fixture ticket for IT-HLT-001',
        respondDueAt: new Date(resolvedRecently.getTime() - 3 * 3_600_000),
        resolveDueAt: new Date(resolvedRecently.getTime() - 3_600_000),
        resolvedAt: resolvedRecently,
      },
    });

    // A sev1 incident detected and resolved inside the last 90 days.
    const detectedAt = new Date(now.getTime() - 5 * 3_600_000);
    await unscopedPrisma.itIncident.create({
      data: {
        tenantId: tid,
        title: `Overview incident ${s}`,
        severity: 'sev1',
        status: 'resolved',
        detectedAt,
        acknowledgedAt: new Date(detectedAt.getTime() + 5 * 60_000),
        mitigatedAt: new Date(detectedAt.getTime() + 60 * 60_000),
        resolvedAt: new Date(detectedAt.getTime() + 90 * 60_000),
      },
    });

    const after = await asUser('chairman@kaizen.co.in', () => computeDomainHealth('H_TEC'));
    expect(after.state).toBe('measured');
    expect(after.score).not.toBeNull();

    const codes = after.factors.map((f) => f.factor).sort();
    // Only the factors with real inputs — no risks, findings, changes or
    // continuity plans exist for this tenant yet.
    expect(codes).toEqual(['incident_recovery', 'sla_attainment']);

    const sla = after.factors.find((f) => f.factor === 'sla_attainment')!;
    expect(sla.drillPath).toBe('/it/tickets?tab=breached');
    expect(sla.value).toBeGreaterThan(0);
    expect(sla.value).toBeLessThan(100);

    const recovery = after.factors.find((f) => f.factor === 'incident_recovery')!;
    expect(recovery.drillPath).toBe('/it/incidents');
    expect(recovery.value).toBeGreaterThan(0);
  });
});
