/**
 * Technology overview and the H_TEC health domain (docs/plan/cio.md, workstream I).
 *
 * The suite runs every file serially against one shared `kaizen` tenant
 * (`vitest.config.ts`), alphabetically — by the time this file runs,
 * `assets`/`governance`/`itsm`/`servicedesk` (and others) have already
 * populated it with real rows. Neither test below assumes the tenant is
 * empty:
 *
 * IT-OVR-001 asserts the *contract* of `overview()` — every section is
 * either `{ withheld: true }` or carries a boolean `notYetMeasured`, no
 * section is missing, and the top-level flag is exactly the conjunction of
 * the fifteen section flags — rather than asserting a specific empty state.
 * It also proves a narrowed role (`employee@kaizen.co.in`, which the grant
 * matrix withholds most technology resources from) gets `withheld` tiles
 * rather than a thrown error.
 *
 * IT-HLT-001 needs a tenant it controls completely — the "not yet measured
 * with no inputs" half of the acceptance ID is meaningless against a tenant
 * other suites have already written tickets and incidents into — so it
 * bootstraps its own tenant (the same `seedBootstrap` used by
 * `spinOut.test.ts`/`equityGroup.test.ts`) and runs both halves inside it.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { asUser, authFor, asPrincipal, unscopedPrisma, type TestPrincipal } from '../helpers.js';
import { seedBootstrap } from '../../seed/bootstrap.js';
import { overview, type Withheld } from '../../domains/it/overview.js';
import { computeDomainHealth } from '../../domains/health.js';

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

type Section = Record<string, unknown>;

function isWithheld(s: Section | Withheld): s is Withheld {
  return (s as Withheld).withheld === true;
}

const SECTION_NAMES = [
  'assets',
  'applications',
  'licences',
  'vendors',
  'contracts',
  'tickets',
  'incidents',
  'changes',
  'risks',
  'findings',
  'policies',
  'initiatives',
  'budget',
  'continuity',
  'availability',
] as const;

describe('IT-OVR-001: the technology overview composes every section honestly', () => {
  it('every section is withheld or carries a boolean notYetMeasured, and the top-level flag follows', async () => {
    const result = await asUser('chairman@kaizen.co.in', () => overview());

    const sections = SECTION_NAMES.map((name) => ({ name, value: (result as unknown as Record<string, Section | Withheld>)[name] }));

    for (const { name, value } of sections) {
      // Never missing.
      expect(value, name).not.toBeNull();
      expect(value, name).not.toBeUndefined();
      expect(typeof value, name).toBe('object');

      if (isWithheld(value)) {
        expect(Object.keys(value)).toEqual(['withheld']);
        continue;
      }

      // Not withheld, so it must carry a real boolean flag — never a
      // section that is silently neither.
      expect(typeof value.notYetMeasured, name).toBe('boolean');
    }

    // The top-level flag is exactly the conjunction of every section's own
    // flag — never hand-set, never disagreeing with what is underneath.
    const expectedTopLevel = sections.every(
      ({ value }) => isWithheld(value) || (value as Section).notYetMeasured === true,
    );
    expect(result.notYetMeasured).toBe(expectedTopLevel);
  });

  it('does not throw for a role the grant matrix narrows, and withholds at least one section for it', async () => {
    // The employee role holds no grant at all on several technology
    // resources (it_licences, it_vendors, it_vendor_contracts, it_incidents,
    // it_risks, it_findings, it_initiatives, it_budgets, it_continuity) —
    // `overview()` must turn each 403 into a withheld tile, never a thrown
    // request failure.
    const result = await asUser('employee@kaizen.co.in', () => overview());

    const sections = SECTION_NAMES.map((name) => (result as unknown as Record<string, Section | Withheld>)[name]);
    expect(sections.some(isWithheld)).toBe(true);

    // The Finance Head's row holds `view` on every technology resource
    // (`docs/plan/cio.md`'s grant matrix), so the same call for that role
    // must simply not throw — the withheld path is exercised above by a
    // role the matrix actually narrows.
    await expect(asUser('finance@kaizen.co.in', () => overview())).resolves.toBeTruthy();
  });
});

describe('IT-HLT-001: H_TEC reports honestly', () => {
  let tenantId: string;
  let chairman: TestPrincipal;

  async function asTenantChairman<T>(fn: () => Promise<T>): Promise<T> {
    return asPrincipal(authFor(chairman), fn);
  }

  beforeAll(async () => {
    const slug = `it-overview-hlt-${stamp()}`;
    const seeded = await seedBootstrap({ tenantSlug: slug, tenantName: `IT overview H_TEC fixture ${slug}` });
    tenantId = seeded.tenantId;

    const user = await unscopedPrisma.user.findFirstOrThrow({ where: { tenantId, email: 'chairman@kaizen.co.in' } });
    const affiliation = await unscopedPrisma.affiliation.findFirstOrThrow({
      where: { partyId: user.personId, tenantId, status: 'active' },
      orderBy: [{ primaryFlag: 'desc' }, { createdAt: 'asc' }],
    });
    chairman = {
      tenantId,
      partyId: user.personId,
      userId: user.id,
      affiliationId: affiliation.id,
      roleSlug: affiliation.roleSlug ?? 'chairman',
      branch: user.branch,
    };
  }, 60_000);

  it('is not yet measured with no tickets or incidents', async () => {
    const before = await asTenantChairman(() => computeDomainHealth('H_TEC'));
    expect(before.state).toBe('not_yet_measured');
    expect(before.score).toBeNull();
    expect(before.factors).toHaveLength(0);
  });

  it('is measured once tickets and incidents exist, with only the factors that have inputs', async () => {
    const s = stamp();

    const requester = await unscopedPrisma.person.create({
      data: { tenantId, recordCode: `PER-OVR-${s}`, fullName: `Overview Requester ${s}`, source: 'test' },
    });

    const now = new Date();
    const resolvedRecently = new Date(now.getTime() - 2 * 86_400_000);

    // Two tickets resolved inside the last 30 days: one inside its
    // resolution clock, one past it — a real, non-trivial SLA reading.
    await unscopedPrisma.itTicket.create({
      data: {
        tenantId,
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
        tenantId,
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
        tenantId,
        title: `Overview incident ${s}`,
        severity: 'sev1',
        status: 'resolved',
        detectedAt,
        acknowledgedAt: new Date(detectedAt.getTime() + 5 * 60_000),
        mitigatedAt: new Date(detectedAt.getTime() + 60 * 60_000),
        resolvedAt: new Date(detectedAt.getTime() + 90 * 60_000),
      },
    });

    const after = await asTenantChairman(() => computeDomainHealth('H_TEC'));
    expect(after.state).toBe('measured');
    expect(after.score).not.toBeNull();

    // This tenant has no risks, findings, changes or continuity plans at
    // all — created fresh by this file, nothing else writes into it — so
    // those four factors must be omitted, not present with a zero.
    const codes = after.factors.map((f) => f.factor).sort();
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
