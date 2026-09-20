/**
 * Chairman's Office — Phase 0 (Foundation) acceptance tests.
 *
 * `docs/plan/ceo-office.md` §6, Phase 0's own "Tests" section: confirms the
 * shared scaffolding is wired correctly before any of phases 1-9 build on
 * top of it — every new resource is declared in both resource lists, every
 * new nav row resolves to a real route, the chairman holds every new
 * resource purely through the existing superadmin map (no bespoke grant
 * rows), every `kz.ceo.*` event name is canonical, and every stub route
 * responds the way a phase can build against.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, afterAll } from 'vitest';
import { RESOURCES, EVENTS, isCanonicalEventName, BOUNDED_CONTEXTS, MODULE_REGISTER } from '@kaizen/shared';
import { ALL_RESOURCES, ROLE_GRANT_MATRIX } from '../../seed/grants.js';
import { NAV_REGISTRY } from '../../seed/bootstrap.js';
import { asUser } from '../helpers.js';
import { signToken } from '../../lib/auth.js';
import { createApp } from '../../server.js';
import type { Server } from 'node:http';

// The 21 resources this module's Phase 0 declares (docs/plan/ceo-office.md §6).
const CEO_RESOURCES = [
  'kpi_definitions', 'ceo_cockpit',
  'strategic_themes', 'objectives', 'key_results',
  'initiatives',
  'meeting_series', 'meeting_instances',
  'doa_matrix', 'ceo_approvals_inbox',
  'board_packs', 'investor_updates', 'stakeholders',
  'risks', 'policy_documents',
  'financial_scenarios', 'headcount_plans',
  'seats', 'one_on_ones', 'succession_candidates', 'time_audit',
] as const;

const CEO_EVENTS = [
  'CEO_KPI_DEFINITION_CREATED', 'CEO_KPI_FORMULA_PUBLISHED', 'CEO_NORTH_STAR_CHANGED',
  'CEO_VISION_SET', 'CEO_AOP_SUBMITTED', 'CEO_AOP_ACTIVATED', 'CEO_OBJECTIVE_CREATED',
  'CEO_OBJECTIVE_SCORED', 'CEO_KEY_RESULT_CHECKED_IN',
  'CEO_INITIATIVE_CREATED', 'CEO_INITIATIVE_STATUS_CHANGED', 'CEO_INITIATIVE_KILLED',
  'CEO_INITIATIVE_MILESTONE_COMPLETED',
  'CEO_MEETING_SCHEDULED', 'CEO_MEETING_CLOSED', 'CEO_ISSUE_RAISED', 'CEO_ISSUE_RESOLVED',
  'CEO_ACTION_ITEM_COMPLETED',
  'CEO_DOA_ENTRY_CHANGED', 'CEO_DELEGATION_CREATED', 'CEO_DELEGATION_ENDED',
  'CEO_BOARD_PACK_ISSUED', 'CEO_INVESTOR_UPDATE_ISSUED', 'CEO_DOCUMENT_CIRCULATED',
  'CEO_DOCUMENT_ACKNOWLEDGED', 'CEO_STAKEHOLDER_TOUCHED',
  'CEO_RISK_RAISED', 'CEO_RISK_CLOSED', 'CEO_POLICY_PUBLISHED', 'CEO_POLICY_ACKNOWLEDGED',
  'CEO_SCENARIO_CREATED', 'CEO_BUDGET_LINE_PROPOSED', 'CEO_HEADCOUNT_PLAN_APPROVED',
  'CEO_SEAT_CREATED', 'CEO_SEAT_REASSIGNED', 'CEO_SUCCESSION_REVIEWED', 'CEO_ONE_ON_ONE_LOGGED',
] as const;

const CEO_NAV_KEYS = [
  'ceo_cockpit', 'ceo_kpi_library', 'ceo_strategy', 'ceo_okrs', 'ceo_initiatives',
  'ceo_meetings', 'ceo_delegation', 'ceo_approvals', 'ceo_board_pack',
  'ceo_investor_updates', 'ceo_stakeholders', 'ceo_risks', 'ceo_policies',
  'ceo_governance', 'ceo_financial_plan', 'ceo_headcount_plan', 'ceo_leadership',
  'ceo_one_on_ones', 'ceo_succession', 'ceo_time_audit',
] as const;

const STUB_AREAS = ['cockpit', 'strategy', 'initiatives', 'rhythm', 'doa', 'board', 'risk', 'finance', 'people'] as const;

/** apps/web/src/main.tsx, read as text — the route table Phase 0 must match. */
function mainTsxSource(): string {
  // this file: apps/api/src/tests/ceo/foundation.test.ts
  const here = fileURLToPath(import.meta.url);
  const apiSrcTests = here.replace(/\/tests\/ceo\/foundation\.test\.ts$/, '');
  const path = `${apiSrcTests}/../../../apps/web/src/main.tsx`;
  return readFileSync(path, 'utf8');
}

describe('CEO-FOUND-001 — every new resource is declared in both resource lists', () => {
  it('appears in the shared RESOURCES array', () => {
    for (const r of CEO_RESOURCES) {
      expect(RESOURCES as readonly string[], `${r} missing from RESOURCES`).toContain(r);
    }
  });

  it('appears in the API-side ALL_RESOURCES array', () => {
    for (const r of CEO_RESOURCES) {
      expect(ALL_RESOURCES as readonly string[], `${r} missing from ALL_RESOURCES`).toContain(r);
    }
  });
});

describe("CEO-FOUND-002 — every new nav row resolves to a real route, and stays off the portal", () => {
  const ceoNav = NAV_REGISTRY.filter((n) => n.group === 'ceo');

  it('registers exactly the 20 screens the master table names', () => {
    expect(ceoNav.map((n) => n.nodeKey).sort()).toEqual([...CEO_NAV_KEYS].sort());
  });

  it("every path matches a <Route> in apps/web/src/main.tsx", () => {
    const src = mainTsxSource();
    for (const node of ceoNav) {
      const needle = `path="${node.path}"`;
      expect(src.includes(needle), `no <Route ${needle}> in main.tsx for ${node.nodeKey}`).toBe(true);
    }
  });

  it('every row sets archetypes explicitly, so none leaks into the portal shell', () => {
    for (const node of ceoNav) {
      expect(node.archetypes, `${node.nodeKey} has no archetypes`).toEqual(['command', 'workspace', 'console']);
    }
  });
});

describe('CEO-FOUND-003 — the chairman holds every new resource purely through the superadmin map', () => {
  it('writes no chairman-specific grant row: every chairman cell is the one generated superadmin cell', () => {
    const cells = new Set(ROLE_GRANT_MATRIX.chairman.map((g) => g.cell));
    expect(cells.size, 'chairman GrantSpec cells are not uniform — a bespoke row was written').toBe(1);
    const chairmanResources = new Set(ROLE_GRANT_MATRIX.chairman.map((g) => g.resource));
    for (const r of CEO_RESOURCES) {
      expect(chairmanResources.has(r), `chairman has no row for ${r}`).toBe(true);
    }
  });

  it('a chairman principal can view every new resource end to end', async () => {
    const { can } = await import('../../platform/permissions.js');
    await asUser('chairman@kaizen.co.in', async () => {
      for (const r of CEO_RESOURCES) {
        const allowed = await can({ resource: r, verb: 'view' });
        expect(allowed, `chairman refused view on ${r}`).toBe(true);
      }
    });
  });
});

describe('CEO-FOUND-004 — every kz.ceo.* event name is canonical and registered', () => {
  it('matches the closed event-name grammar', () => {
    for (const key of CEO_EVENTS) {
      const name = (EVENTS as Record<string, string>)[key];
      expect(name, `EVENTS.${key} missing`).toBeTruthy();
      expect(isCanonicalEventName(name), `${name} is not canonical`).toBe(true);
      expect(name.startsWith('kz.ceo.'), `${name} is not in the kz.ceo.* grammar`).toBe(true);
    }
  });
});

describe("CEO-FOUND-005 — the 'ceo' bounded context and module register entry are wired", () => {
  it('is a bounded context', () => {
    expect(BOUNDED_CONTEXTS as readonly string[]).toContain('ceo');
  });

  it('has a MODULE_REGISTER entry naming what it owns and never does', () => {
    const entry = MODULE_REGISTER.find((m) => m.boundedContext === 'ceo');
    expect(entry).toBeTruthy();
    expect(entry!.owns.length).toBeGreaterThan(0);
    expect(entry!.neverDoes.length).toBeGreaterThan(0);
  });
});

describe('CEO-FOUND-006 — every stub route answers the way a phase can build against', () => {
  let server: Server;
  let base: string;

  afterAll(() => {
    server?.close();
  });

  it('GET returns { items: [] } and POST returns 501, for every area, under the chairman', async () => {
    if (!server) {
      const app = createApp();
      server = app.listen(0);
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      base = `http://127.0.0.1:${port}/api`;
    }

    const { principalFor } = await import('../helpers.js');
    const p = await principalFor('chairman@kaizen.co.in');
    const token = signToken({ userId: p.userId, tenantId: p.tenantId, affiliationId: p.affiliationId, stepUp: true });
    const headers = { Authorization: `Bearer ${token}` };

    for (const area of STUB_AREAS) {
      const getRes = await fetch(`${base}/ceo/${area}`, { headers });
      expect(getRes.status, `GET /ceo/${area}`).toBe(200);
      const getBody = (await getRes.json()) as { items: unknown[] };
      expect(getBody).toEqual({ items: [] });

      const postRes = await fetch(`${base}/ceo/${area}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(postRes.status, `POST /ceo/${area}`).toBe(501);
      const postBody = (await postRes.json()) as { message: string };
      expect(postBody.message).toBe('Not built yet.');
    }
  });

  it('an unauthenticated request is refused before it reaches a stub handler', async () => {
    const res = await fetch(`${base}/ceo/cockpit`);
    expect(res.status).toBe(401);
  });
});

describe('CEO-FOUND-007 — a non-chairman, non-named role is refused on a chairman-only resource', () => {
  it('an employee cannot view the DoA matrix or the succession register', async () => {
    await asUser('arun@kaizen.co.in', async () => {
      const { can } = await import('../../platform/permissions.js');
      const doa = await can({ resource: 'doa_matrix', verb: 'view' });
      const succession = await can({ resource: 'succession_candidates', verb: 'view' });
      expect(doa).toBe(false);
      expect(succession).toBe(false);
    });
  });

  it('finance_head sees the KPI library and the financial scenarios, never the DoA matrix', async () => {
    const { can } = await import('../../platform/permissions.js');
    await asUser('controller@kaizen.co.in', async () => {
      const kpi = await can({ resource: 'kpi_definitions', verb: 'view' });
      const scenarios = await can({ resource: 'financial_scenarios', verb: 'view' });
      const doa = await can({ resource: 'doa_matrix', verb: 'view' });
      expect(kpi).toBe(true);
      expect(scenarios).toBe(true);
      expect(doa).toBe(false);
    });
  });
});

describe('CEO-FOUND-008 — no service code compares a role slug for this module (§3.5)', () => {
  it('a source grep of domains/ceo for a role-slug literal comparison returns empty', async () => {
    const { execSync } = await import('node:child_process');
    const out = execSync(
      "grep -rnE \"roleSlug\\s*[=!]==\\s*['\\\"]\" src/domains/ceo src/routes/ceo || true",
      { cwd: fileURLToPath(new URL('../../..', import.meta.url)) },
    )
      .toString()
      .trim();
    expect(out).toBe('');
  });
});
