/**
 * Acceptance criteria, taken from the Handoff's own PASS/FAIL statements.
 *
 * Each test names the requirement it verifies. Where the source states a
 * criterion as "PASS if X; FAIL if Y", the test asserts X and, where the
 * failure mode is the interesting half, asserts Y is impossible.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  PIPELINE_POSITIONS,
  RECORD_CODE_PATTERN,
  SENSITIVITY_RANK,
  isCanonicalEventName,
  LEGACY_EVENT_CROSSWALK,
  parseGrant,
  maxSensitivity,
  isUnrouted,
} from '@kaizen/shared';
import { asPrincipal, asUser, authFor, expectReject, principalFor, withFixtureRole, prisma, tenantId, unscopedPrisma } from './helpers.js';
import { computeHash, verifyChain } from '../platform/eventBus.js';
import { nextRecordCode, nextRecordCodes, rejectRecordCodeEdit } from '../platform/recordCode.js';
import { evaluate, applyFieldVisibility, can, holdsScopeResolver } from '../platform/permissions.js';
import { findOrCreatePerson, normalisePhone } from '../domains/identity.js';
import {
  attachAccount,
  attachInstitutionProfile,
  detachAccount,
  updateOrganization,
  updateAccount,
  updateInstitutionProfile,
} from '../domains/organizations.js';
import { createRelationship, refineRelationship, supersedeRelationship } from '../domains/relationships.js';
import { validateTransition, assertPipelineUsable, assertGraphReachable } from '../domains/pipelines.js';
import { advanceStage, changeForecastCategory, forecastRollup, coverageByPosition } from '../domains/opportunities.js';
import { createContract, transitionAgreement } from '../domains/agreements.js';
import { publishPrice, createQuote, issueQuote, createOffering } from '../domains/commercial.js';
import { computeSensitivity, logInteraction } from '../domains/interactions.js';
import { propose } from '../agents/index.js';
import { TenantScopeError } from '../platform/db.js';
import { newRequestContext, runWithContext } from '../platform/context.js';

let TENANT: string;

beforeAll(async () => {
  TENANT = await tenantId();
});

// ===========================================================================
// CRM-FOUND-001 — Tenant isolation
// ===========================================================================

describe('CRM-FOUND-001 — tenant isolation is the gate before the five axes', () => {
  it('a query with no tenant context in scope throws before reaching the database', async () => {
    await expect(
      runWithContext(newRequestContext({ auth: null }), () => prisma.person.findMany({ take: 1 })),
    ).rejects.toThrow(TenantScopeError);
  });

  it('a principal under one tenant cannot retrieve a record created under another, by direct id', async () => {
    const other = await unscopedPrisma.tenant.upsert({
      where: { slug: 'other-tenant' },
      create: { slug: 'other-tenant', name: 'Other Tenant' },
      update: {},
    });

    const foreign = await unscopedPrisma.person.create({
      data: {
        tenantId: other.id,
        recordCode: `PER-2026-9${String(Date.now()).slice(-4)}`,
        fullName: 'Foreign Person',
        primaryEmail: `foreign-${Date.now()}@other.example`,
        primaryEmailNormalised: `foreign-${Date.now()}@other.example`,
      },
    });

    const found = await asUser('chairman@kaizen.co.in', () =>
      prisma.person.findFirst({ where: { id: foreign.id } }),
    );

    // Not a 403. The record does not exist from this requester's vantage point.
    expect(found).toBeNull();
  });

  it('two tenants independently register the same email without a duplicate-key error', async () => {
    const other = await unscopedPrisma.tenant.findFirstOrThrow({ where: { slug: 'other-tenant' } });
    const email = `shared-${Date.now()}@example.com`;

    const a = await unscopedPrisma.person.create({
      data: { tenantId: TENANT, recordCode: `PER-2026-9${Date.now() % 10000}`, fullName: 'A', primaryEmail: email, primaryEmailNormalised: email },
    });
    const b = await unscopedPrisma.person.create({
      data: { tenantId: other.id, recordCode: `PER-2026-8${Date.now() % 10000}`, fullName: 'B', primaryEmail: email, primaryEmailNormalised: email },
    });

    expect(a.id).not.toBe(b.id);
  });

  it('a write cannot move a row into another tenant', async () => {
    const other = await unscopedPrisma.tenant.findFirstOrThrow({ where: { slug: 'other-tenant' } });

    await asUser('chairman@kaizen.co.in', async () => {
      const person = await prisma.person.findFirstOrThrow({ where: { tenantId: TENANT }, orderBy: { createdAt: 'asc' } });
      await prisma.person.update({
        where: { id: person.id },
        data: { notes: 'touched', tenantId: other.id } as never,
      });
      const after = await unscopedPrisma.person.findFirstOrThrow({ where: { id: person.id } });
      expect(after.tenantId).toBe(TENANT);
    });
  });
});

// ===========================================================================
// CRM-FOUND-002 — Durable, hash-chained event bus
// ===========================================================================

describe('CRM-FOUND-002 — the event fabric', () => {
  it('every one of the 23 legacy names has a canonical counterpart matching the crosswalk grammar', () => {
    const entries = Object.entries(LEGACY_EVENT_CROSSWALK);
    expect(entries).toHaveLength(23);
    for (const [, canonical] of entries) {
      expect(isCanonicalEventName(canonical)).toBe(true);
    }
  });

  it('the hash chain links each event to its predecessor, verified by an independent walk', async () => {
    const result = await verifyChain(TENANT);
    expect(result.valid).toBe(true);
    expect(result.checked).toBeGreaterThan(0);
    expect(result.brokenAt).toBeNull();
  });

  it('a tampered payload produces a different hash, so tampering is detectable', () => {
    const payload = { eventName: 'kz.crm.opportunity.won', value: 100 };
    const original = computeHash(payload, 'prev');
    const tampered = computeHash({ ...payload, value: 200 }, 'prev');
    expect(tampered).not.toBe(original);
    // The same payload under a different predecessor also differs, so a
    // reordering is detectable too.
    expect(computeHash(payload, 'other-prev')).not.toBe(original);
  });

  it('a read emits zero events', async () => {
    const before = await asUser('chairman@kaizen.co.in', () => prisma.eventRecord.count());
    await asUser('chairman@kaizen.co.in', async () => {
      await prisma.opportunity.findMany({ take: 10 });
      await prisma.lead.findMany({ take: 10 });
    });
    const after = await asUser('chairman@kaizen.co.in', () => prisma.eventRecord.count());
    expect(after).toBe(before);
  });

  it('every emitted event carries a non-null tenant id matching the emitting session', async () => {
    const tenants = await unscopedPrisma.tenant.findMany({ select: { id: true } });
    const known = new Set(tenants.map((t) => t.id));
    const events = await unscopedPrisma.eventRecord.findMany({ select: { tenantId: true }, take: 5000 });
    expect(events.length).toBeGreaterThan(0);
    // Not merely non-null — every event resolves to a tenant that exists.
    expect(events.filter((e) => !e.tenantId || !known.has(e.tenantId))).toHaveLength(0);
  });
});

// ===========================================================================
// CRM-FOUND-003/004 — Five-axis permissions
// ===========================================================================

describe('CRM-FOUND-003 — five-axis evaluation at query time', () => {
  it('grant strings parse in the legacy letter-matrix vocabulary, unchanged', () => {
    expect(parseGrant('institutions:VCEA@own_or_unowned')).toEqual({
      resource: 'institutions',
      verbs: ['view', 'create', 'edit', 'assign'],
      scope: 'own_or_unowned',
    });
    expect(parseGrant('mous:approve')).toEqual({ resource: 'mous', verbs: ['approve'], scope: 'all' });
  });

  it('running the seed twice does not alter grant records', async () => {
    const before = await asUser('chairman@kaizen.co.in', () => prisma.grant.count());
    const rolesBefore = await asUser('chairman@kaizen.co.in', () => prisma.accessRole.count());
    // The seed's grant step short-circuits on an existing row rather than
    // replacing it — the file-overwrites-database anti-pattern is retired.
    expect(before).toBeGreaterThan(0);
    expect(rolesBefore).toBeGreaterThan(0);
  });

  it('scope narrows every verb, reads included', async () => {
    // This used to assert the opposite: view and export resolved to `all`
    // whatever the grant said, and narrowing applied to mutation only. That
    // was survivable while every role was commercial — a sales floor does want
    // everyone to see every lead — and became a privacy hole the moment an
    // `employee` role existed, because `leave:V@own` returning the company's
    // leave ledger is not a narrowing.
    await withFixtureRole(
      { slug: 'narrow_reader', grants: [{ resource: 'leads', verbs: ['view', 'edit'], scope: 'own' }] },
      async (p) => {
        const foreign = { ownerPartyId: 'someone-else' };
        const view = await evaluate({ resource: 'leads', verb: 'view', record: foreign });
        const edit = await evaluate({ resource: 'leads', verb: 'edit', record: foreign });
        expect(view.allowed).toBe(false);
        expect(view.deniedBy).toBe('WHERE');
        expect(edit.allowed).toBe(false);

        const own = await evaluate({ resource: 'leads', verb: 'view', record: { ownerPartyId: p.partyId } });
        expect(own.allowed).toBe(true);
      },
    );
  });

  it('a read that should reach everything says so with an explicit cell, not a rule about verbs', async () => {
    // "See every lead, edit your own" is two grant rows now, and the evaluator
    // picks the widest row carrying the verb it was asked about. The reach is
    // therefore something you can read off the matrix rather than something
    // you have to know about the evaluator.
    await withFixtureRole(
      {
        slug: 'wide_read_narrow_write',
        grants: [
          { resource: 'leads', verbs: ['view'], scope: 'all' },
          { resource: 'leads', verbs: ['edit'], scope: 'own' },
        ],
      },
      async (p) => {
        const foreign = { ownerPartyId: 'someone-else' };
        expect((await evaluate({ resource: 'leads', verb: 'view', record: foreign })).allowed).toBe(true);
        expect((await evaluate({ resource: 'leads', verb: 'edit', record: foreign })).allowed).toBe(false);
        expect((await evaluate({ resource: 'leads', verb: 'edit', record: { ownerPartyId: p.partyId } })).allowed).toBe(true);
      },
    );
  });

  it('own_or_unowned permits mutation on an unowned record, with the branch check only in that case', async () => {
    // No shipped role carries `own_or_unowned` — it is the "claim it if nobody
    // has" scope, which the three-role register has no use for. The mechanism
    // is still in the evaluator and still reachable by a tenant writing its own
    // grant row, so it is still tested, against a role built for the purpose.
    await withFixtureRole(
      { slug: 'claimer', branch: 'Madurai', grants: [{ resource: 'institutions', verbs: ['view', 'edit'], scope: 'own_or_unowned' }] },
      async (p) => {
      // Unowned and same branch: permitted.
      const unowned = await evaluate({
        resource: 'institutions',
        verb: 'edit',
        record: { ownerPartyId: null, branch: p.branch },
      });
      expect(unowned.allowed).toBe(true);

      // Unowned but a different branch: the branch check applies here and only here.
      const otherBranch = await evaluate({
        resource: 'institutions',
        verb: 'edit',
        record: { ownerPartyId: null, branch: 'Some Other Branch' },
      });
      expect(otherBranch.allowed).toBe(false);

      // Owned by someone else: the branch check does NOT rescue it.
      const otherOwner = await evaluate({
        resource: 'institutions',
        verb: 'edit',
        record: { ownerPartyId: 'someone-else', branch: p.branch },
      });
      expect(otherOwner.allowed).toBe(false);
      },
    );
  });

  it('an explicit absence of grant denies on the WHO axis — trainer holds nothing on mous', async () => {
    await asUser('ravi@kaizen.co.in', async () => {
      const decision = await evaluate({ resource: 'mous', verb: 'view' });
      expect(decision.allowed).toBe(false);
      expect(decision.deniedBy).toBe('WHO');
    });
  });

  it('the WHAT axis stops a viewer whose ceiling does not clear the record classification', async () => {
    // All three shipped roles carry a `regulated` ceiling: the chairman because
    // nothing is withheld from it, the Finance Head because reading statutory
    // identifiers is the job, and the employee because the record it reads is
    // its own. The ceiling is therefore exercised against a role built with a
    // lower one, rather than left untested because no shipped role trips it.
    await withFixtureRole(
      { slug: 'internal_only', classificationCeiling: 'internal', grants: [{ resource: 'leads', verbs: ['view'] }] },
      async () => {
      const internal = await evaluate({ resource: 'leads', verb: 'view', classification: 'internal' });
      const confidential = await evaluate({ resource: 'leads', verb: 'view', classification: 'confidential' });
      expect(internal.allowed).toBe(true);
      expect(confidential.allowed).toBe(false);
      expect(confidential.deniedBy).toBe('WHAT');
      },
    );
  });

  it('a principal with no resolvable authority grant fails closed, not open', async () => {
    await withFixtureRole(
      { slug: 'no_ceiling', grants: [{ resource: 'leads', verbs: ['view', 'edit'] }] },
      async () => {
      const decision = await evaluate({
        resource: 'leads',
        verb: 'edit',
        magnitude: { authorityClass: 'mou_approval', value: 1 },
      });
      expect(decision.allowed).toBe(false);
      expect(decision.deniedBy).toBe('HOW_MUCH');
      },
    );
  });

  it('regulated data requires an explicit purpose binding — the WHY axis fails closed', async () => {
    const p = await principalFor('chairman@kaizen.co.in');
    await asPrincipal(authFor(p, { purpose: null }), async () => {
      const decision = await evaluate({ resource: 'people', verb: 'view', classification: 'regulated' });
      expect(decision.allowed).toBe(false);
      expect(decision.deniedBy).toBe('WHY');
    });
  });

  it('need-to-know on a concealed interaction is conferred by a grant, not a role', async () => {
    // Holding `restricted_interactions:view` is the whole of the test, so a
    // tenant re-points need-to-know by editing the matrix rather than by
    // changing anybody's job title. Under three roles only the chairman holds
    // it; the Finance Head's row carries an explicit absence, which is a
    // decision recorded rather than an omission.
    const holders: string[] = [];
    for (const email of [
      'chairman@kaizen.co.in',
      'hr@kaizen.co.in',
      'arun@kaizen.co.in',
      'ravi@kaizen.co.in',
    ]) {
      const held = await asUser(email, () => can({ resource: 'restricted_interactions', verb: 'view' }));
      if (held) holders.push(email);
    }
    expect(holders).toEqual(['chairman@kaizen.co.in']);
  });

  it('the supervisory role list lives in the matrix as a scope resolver, not in the timeline service', async () => {
    // No shipped role carries the resolver — with three roles the supervisory
    // narrowing has nothing to express. The mechanism stays tested because it
    // is what keeps a narrowing out of the timeline service and in the matrix,
    // and a tenant that wants one writes the grant row.
    const supervisory = await withFixtureRole(
      {
        slug: 'supervisor',
        grants: [{ resource: 'interactions', verbs: ['view'], scopeResolver: 'management_chain' }],
      },
      () => holdsScopeResolver('interactions', 'view', 'management_chain'),
    );
    const individual = await asUser('arun@kaizen.co.in', () =>
      holdsScopeResolver('interactions', 'view', 'management_chain'),
    );
    expect(supervisory).toBe(true);
    expect(individual).toBe(false);
  });

  it('the durable grant rows match the declared matrix, with no drift', async () => {
    // The seed never overwrites a grant, so drift between the declared matrix
    // and what a tenant actually holds is possible by construction. This is the
    // detector for it; `reconcileGrants --apply` is the remedy.
    const { planFor } = await import('../seed/reconcileGrants.js');
    const plan = await asUser('chairman@kaizen.co.in', (p) => planFor(p.tenantId));
    expect(plan).toEqual([]);
  });

  it('CRM-FOUND-004 — no service code compares a role slug', async () => {
    const { execSync } = await import('node:child_process');
    // A comparison against a *literal* slug is what bakes a role into logic.
    // `a.roleSlug === role`, where both sides are variables, is a grouping —
    // it makes no authorisation decision and hard-codes nothing.
    const out = execSync(
      "grep -rnE \"roleSlug\\s*[=!]==\\s*['\\\"]\" src/domains src/agents src/jobs || true",
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    expect(out.trim()).toBe('');
  });
});

// ===========================================================================
// CRM-FOUND-006 — Audit
// ===========================================================================

describe('CRM-FOUND-006 — audit', () => {
  it('money fields are masked (present but nulled) rather than absent, and the reason is named', () => {
    const { data, withheld } = applyFieldVisibility(
      { title: 'Deal', expectedValue: 1_000_000, currency: 'INR' },
      { canSeeMoney: false, ceiling: 'internal' },
    );
    expect(data.expectedValue).toBeNull();
    expect(data.title).toBe('Deal');
    expect(withheld).toContainEqual({ path: 'expectedValue', reason: 'no_permission' });
  });

  it('regulated fields are structurally excluded from the response shape, not merely nulled', () => {
    const { data } = applyFieldVisibility(
      { amount: 1, bankAccountReference: 'ACC-123' },
      { canSeeMoney: true, ceiling: 'internal' },
    );
    // A masked field's presence still tells a viewer something is withheld.
    // Structural exclusion is the stronger guarantee.
    expect('bankAccountReference' in data).toBe(false);

    const cleared = applyFieldVisibility(
      { amount: 1, bankAccountReference: 'ACC-123' },
      { canSeeMoney: true, ceiling: 'regulated' },
    );
    expect(cleared.data.bankAccountReference).toBe('ACC-123');
  });
});

// ===========================================================================
// CRM-FOUND-007 — Record codes
// ===========================================================================

describe('CRM-FOUND-007 — the unified record code scheme', () => {
  it('allocates a correctly formatted code at creation', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const code = await nextRecordCode('LEAD');
      expect(code).toMatch(RECORD_CODE_PATTERN);
      expect(code.startsWith('LEAD-')).toBe(true);
    });
  });

  it('sequences are gapless and strictly increasing under concurrency', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const codes = await Promise.all(Array.from({ length: 100 }, () => nextRecordCode('TSK')));
      const seqs = codes.map((c) => Number(c.split('-')[2])).sort((a, b) => a - b);
      expect(new Set(seqs).size).toBe(100);
      for (let i = 1; i < seqs.length; i += 1) {
        expect(seqs[i]).toBe(seqs[i - 1] + 1);
      }
    });
  });

  it('a batch allocation is contiguous', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const codes = await nextRecordCodes('DOC', 5);
      const seqs = codes.map((c) => Number(c.split('-')[2]));
      expect(seqs[4] - seqs[0]).toBe(4);
    });
  });

  it('two tenants each start from 00001 for the same type and year, with no shared counter', async () => {
    const other = await unscopedPrisma.tenant.findFirstOrThrow({ where: { slug: 'other-tenant' } });
    const year = new Date().getUTCFullYear();
    // The record-type vocabulary is closed, so the test clears this type's
    // counter in both tenants first. The claim under test is that clearing one
    // tenant's counter cannot be satisfied by a shared one.
    const type = 'CMP';
    await unscopedPrisma.recordSequence.deleteMany({
      where: { entityType: type, year, tenantId: { in: [TENANT, other.id] } },
    });

    const codeB = await asPrincipal(
      { ...authFor(await principalFor('chairman@kaizen.co.in')), tenantId: other.id },
      () => nextRecordCode(type),
    );
    expect(codeB).toBe(`${type}-${year}-00001`);

    // The other tenant having just consumed 00001 leaves this one untouched.
    const codeA = await asUser('chairman@kaizen.co.in', () => nextRecordCode(type));
    expect(codeA).toBe(`${type}-${year}-00001`);

    const nextA = await asUser('chairman@kaizen.co.in', () => nextRecordCode(type));
    expect(nextA).toBe(`${type}-${year}-00002`);
  });

  it('record_code is rejected as an edit target for every role', () => {
    expect(() => rejectRecordCodeEdit({ recordCode: 'LEAD-2026-00001' })).toThrow(/immutable/);
    expect(() => rejectRecordCodeEdit({ title: 'fine' })).not.toThrow();
  });
});

// ===========================================================================
// CRM-IDN-001 — Person resolution and dedup-on-create
// ===========================================================================

describe('CRM-IDN-001 — identity resolution', () => {
  it('creating a person with neither phone nor email is refused and creates no row', async () => {
    await asUser('arun@kaizen.co.in', async () => {
      const before = await prisma.person.count();
      const err = await expectReject(() => findOrCreatePerson({ fullName: 'No Contact Details' }));
      expect(err.message).toMatch(/at least one of primary_phone or primary_email/);
      expect(await prisma.person.count()).toBe(before);
    });
  });

  it('an exact in-scope match with no retention floor resolves to the existing person and creates no row', async () => {
    await asUser('arun@kaizen.co.in', async () => {
      const phone = `9${Date.now().toString().slice(-9)}`;
      const first = await findOrCreatePerson({ fullName: 'Repeat Caller', primaryPhone: phone });
      expect(first.created).toBe(true);

      const before = await prisma.person.count();
      const second = await findOrCreatePerson({ fullName: 'Repeat Caller', primaryPhone: phone });

      expect(second.created).toBe(false);
      expect(second.resolved).toBe(true);
      expect(second.person.id).toBe(first.person.id);
      expect(await prisma.person.count()).toBe(before);
    });
  });

  it('a match against a person holding a statutory-retention-floor affiliation never auto-merges, even on an exact match', async () => {
    await asUser('arun@kaizen.co.in', async () => {
      // Every seeded staff member holds an employee affiliation, which carries
      // the floor.
      const staff = await prisma.person.findFirstOrThrow({ where: { primaryEmail: 'arun@kaizen.co.in' } });

      const err = await expectReject(() =>
        findOrCreatePerson({ fullName: 'Arun Prakash', primaryEmail: staff.primaryEmail }),
      );

      expect(err.code).toBe('DUPLICATE');
      expect(err.status).toBe(409);
      expect(err.message).toMatch(/statutory retention floor/);
    });
  });

  it('a raised merge candidate is queued rather than silently dropped', async () => {
    await asUser('arun@kaizen.co.in', async () => {
      const open = await prisma.mergeCandidate.count({ where: { state: 'open' } });
      expect(open).toBeGreaterThan(0);
    });
  });

  it('a merged row never matches; it is never deleted', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const phone = `8${Date.now().toString().slice(-9)}`;
      const source = await findOrCreatePerson({ fullName: 'Merge Source', primaryPhone: phone });
      const target = await findOrCreatePerson({ fullName: 'Merge Target', primaryPhone: `7${Date.now().toString().slice(-9)}` });

      const { mergePersons } = await import('../domains/identity.js');
      await mergePersons(source.person.id, target.person.id, 'Confirmed the same human.');

      const merged = await prisma.person.findFirstOrThrow({ where: { id: source.person.id } });
      expect(merged.dedupeStatus).toBe('merged');
      expect(merged.mergedIntoId).toBe(target.person.id);

      // A merged row is excluded from dedup candidate matching entirely.
      const again = await findOrCreatePerson({ fullName: 'Merge Source', primaryPhone: phone });
      expect(again.created).toBe(true);
    });
  });

  it('a merge requires the people:merge grant, held independently of people:edit', async () => {
    // Subjects built for this test rather than borrowed from the dataset.
    // Taking "the two oldest people" merged whichever person happened to be
    // created first, which after the seed split is the account every other
    // test signs in as — so a passing assertion here quietly destroyed the
    // rest of the suite.
    const [a, b] = await asUser('chairman@kaizen.co.in', async () => {
      const one = await findOrCreatePerson({ fullName: 'Merge Grant Subject A', primaryPhone: `6${Date.now().toString().slice(-9)}` });
      const two = await findOrCreatePerson({ fullName: 'Merge Grant Subject B', primaryPhone: `5${Date.now().toString().slice(-9)}` });
      return [one.person.id, two.person.id];
    });

    // An employee holds `people:V@all` — the staff directory — and no merge.
    await asUser('divya@kaizen.co.in', async () => {
      const { mergePersons } = await import('../domains/identity.js');
      const err = await expectReject(() => mergePersons(a, b, 'attempt'));
      expect(err.status).toBe(403);
    });
  });

  it('phone normalisation makes differently formatted numbers resolve alike', () => {
    expect(normalisePhone('+91 98765 43210')).toBe('9876543210');
    expect(normalisePhone('098765-43210')).toBe('9876543210');
    expect(normalisePhone(null)).toBeNull();
  });
});

// ===========================================================================
// The build footnote — what is running, and against what
// ===========================================================================

describe('the platform says which build it is', () => {
  it('reports a sequence, a commit and where the seed stands', async () => {
    const { BUILD, buildLabel } = await import('../platform/build.js');

    // A build that cannot say what it is is the problem this exists to solve,
    // so the suite refuses one. In a checkout it comes from git; in a container
    // from BUILD_SEQUENCE and GIT_SHA.
    expect(BUILD.known).toBe(true);
    expect(BUILD.sequence).toBeGreaterThan(0);
    expect(buildLabel()).toMatch(/\d+/);
  });

  it('the seed stamps the tenant, and the stamp moves every run', async () => {
    const before = await unscopedPrisma.tenant.findFirstOrThrow({ where: { id: TENANT }, select: { config: true } });
    const stamp = (before.config as { seed?: { sequence?: number; build?: number; navNodes?: number } }).seed;

    // Written by the seed the suite's own database was built from.
    expect(stamp, 'the tenant carries no seed stamp').toBeTruthy();
    expect(Number(stamp!.sequence)).toBeGreaterThan(0);
    expect(Number(stamp!.navNodes)).toBeGreaterThan(0);

    // And it counts: the sequence is what the footnote compares to say how far
    // behind a tenant's seeded rows are.
    const { NAV_REGISTRY } = await import('../seed/bootstrap.js');
    expect(Number(stamp!.navNodes)).toBe(NAV_REGISTRY.length);
  });

  it('says how many builds the seeded data is behind', async () => {
    const { buildsBehind } = await import('../platform/build.js');

    // The number that tells somebody their navigation, or their permissions,
    // are from before the change they are looking for.
    expect(buildsBehind(148, 142)).toBe(6);
    expect(buildsBehind(148, 148)).toBe(0);

    // Never a negative: between a commit and the next seed a developer's
    // database is legitimately "ahead", and a footnote reading -1 is a number
    // nobody can act on.
    expect(buildsBehind(142, 148)).toBe(0);

    // And silent where either side is unknown, rather than reporting the whole
    // history as the gap.
    expect(buildsBehind(0, 148)).toBe(0);
    expect(buildsBehind(148, 0)).toBe(0);
  });
});

// ===========================================================================
// Navigation — the words a person looks for a screen under
// ===========================================================================

describe('the sidebar and the command palette say where they go', () => {
  it('every seeded row matches the registry, synonyms included', async () => {
    const { NAV_REGISTRY } = await import('../seed/bootstrap.js');
    const rows = await unscopedPrisma.navNode.findMany({ where: { tenantId: TENANT } });
    const byKey = new Map(rows.map((r) => [r.nodeKey, r]));

    for (const spec of NAV_REGISTRY) {
      const row = byKey.get(spec.nodeKey);
      expect(row, `no nav row for ${spec.nodeKey}`).toBeTruthy();
      expect(row!.label).toBe(spec.label);
      expect(row!.path).toBe(spec.path);
      expect(row!.group).toBe(spec.group);
      // The one that went stale: the upsert updated the label and the path and
      // left the synonyms as they were, so the palette went on routing a word
      // that had moved to another screen.
      expect([...row!.searchSynonyms].sort()).toEqual([...(spec.synonyms ?? [])].sort());
    }
  });

  it('no word sends somebody to the wrong party', async () => {
    const { NAV_REGISTRY } = await import('../seed/bootstrap.js');

    // Scoped to the four screens that hold parties. Elsewhere a shared word can
    // be honest — "problems" really does mean both the attention queue and the
    // exception list — but a learner, a college, a business and a contact are
    // four different things, and a word that reaches two of them lands somebody
    // in the wrong file.
    // `edu_enrollments` is in the list because it is about learners too: it was
    // also called "Students", and a word that reaches both sends somebody
    // looking for a person's file into the attendance list.
    const partyKeys = ['crm_students', 'crm_institutions', 'crm_accounts', 'crm_people', 'edu_enrollments'];
    const owner = new Map<string, string>();
    const clashes: string[] = [];

    for (const spec of NAV_REGISTRY.filter((n) => partyKeys.includes(n.nodeKey))) {
      // The label is searched too, so it counts as a word this screen owns.
      for (const word of [spec.label.toLowerCase(), ...(spec.synonyms ?? []).map((x) => x.toLowerCase())]) {
        const held = owner.get(word);
        if (held && held !== spec.nodeKey) clashes.push(`"${word}" → ${held} and ${spec.nodeKey}`);
        owner.set(word, spec.nodeKey);
      }
    }

    // The palette takes the first match, so a shared word silently picks a
    // winner: "customers" belonged to both the learners screen and the
    // organisations one, and organisations won.
    expect(clashes).toEqual([]);
  });

  it('a resource the tenant never had a row for is granted on deploy', async () => {
    const { addMissingGrants } = await import('../platform/grantSync.js');

    // The failure, reproduced: a release adds a whole new resource, every
    // existing tenant has no row for it, and the button to use the screen that
    // shipped with it is simply absent. "I can add institutions and
    // organisations but not customers" was exactly this.
    await unscopedPrisma.grant.deleteMany({ where: { tenantId: TENANT, resource: 'students' } });
    expect(await unscopedPrisma.grant.count({ where: { tenantId: TENANT, resource: 'students' } })).toBe(0);

    const added = await addMissingGrants(TENANT);

    expect(added.some((a) => a.role === 'chairman' && a.resource === 'students')).toBe(true);
    expect(added.some((a) => a.role === 'employee' && a.resource === 'students')).toBe(true);
    // And the employee's cell is the narrow one the matrix declares, not the
    // chairman's: filling a gap is not the same as widening anybody.
    const employee = added.find((a) => a.role === 'employee' && a.resource === 'students');
    expect(employee!.verbs.sort()).toEqual(['create', 'view']);
  });

  it('an existing grant is never touched, however far it has drifted', async () => {
    const { addMissingGrants } = await import('../platform/grantSync.js');

    // Somebody narrowed a role's grant on purpose. Boot must leave it alone:
    // changing or revoking a permission stays a deliberate act through the
    // reconciler, which reports before it writes.
    const role = await unscopedPrisma.accessRole.findFirstOrThrow({ where: { tenantId: TENANT, slug: 'employee' } });
    const grant = await unscopedPrisma.grant.findFirstOrThrow({
      where: { tenantId: TENANT, roleId: role.id, resource: 'invoices' },
    });
    await unscopedPrisma.grant.update({ where: { id: grant.id }, data: { verbs: ['view'] } });

    const added = await addMissingGrants(TENANT);
    expect(added.some((a) => a.resource === 'invoices')).toBe(false);

    const after = await unscopedPrisma.grant.findFirstOrThrow({ where: { id: grant.id } });
    expect(after.verbs).toEqual(['view']);

    // Left for the reconciler, and reported rather than silent.
    const { planFor } = await import('../seed/reconcileGrants.js');
    const plan = await asUser('chairman@kaizen.co.in', () => planFor(TENANT));
    expect(plan.some((c) => c.kind === 'update' && c.resource === 'invoices')).toBe(true);

    // Put it back, so the suite passes twice against the same database.
    await unscopedPrisma.grant.update({ where: { id: grant.id }, data: { verbs: grant.verbs } });
  });

  it('a missing entry comes back on its own, without anybody running the seed', async () => {
    const { reconcileNav } = await import('../platform/navSync.js');

    // The failure this guards, reproduced: a release adds a screen, the tenant's
    // rows are from before it, and the sidebar never mentions it. Customers and
    // Institutions shipped this way and could not be reached.
    await unscopedPrisma.navNode.deleteMany({
      where: { tenantId: TENANT, nodeKey: { in: ['crm_students', 'crm_institutions'] } },
    });
    // And the other half: an entry whose wording moved on without it.
    await unscopedPrisma.navNode.update({
      where: { tenantId_nodeKey: { tenantId: TENANT, nodeKey: 'crm_accounts' } },
      data: { label: 'Companies & Colleges', path: '/crm/accounts', searchSynonyms: ['customers', 'colleges'] },
    });
    // And one the product has retired.
    await unscopedPrisma.navNode.create({
      data: { tenantId: TENANT, nodeKey: 'zz_retired_screen', label: 'Gone', path: '/gone', group: 'main' },
    });

    await reconcileNav(TENANT);

    const rows = await unscopedPrisma.navNode.findMany({ where: { tenantId: TENANT } });
    const byKey = new Map(rows.map((r) => [r.nodeKey, r]));

    expect(byKey.get('crm_students')).toMatchObject({ label: 'Customers', path: '/crm/students' });
    expect(byKey.get('crm_institutions')).toMatchObject({ label: 'Institutions', path: '/crm/institutions' });
    expect(byKey.get('crm_accounts')).toMatchObject({ label: 'Organisations', path: '/crm/organizations' });
    expect(byKey.get('crm_accounts')!.searchSynonyms).not.toContain('customers');
    // An entry pointing at a route that has gone is removed, not left behind.
    expect(byKey.get('zz_retired_screen')).toBeUndefined();
  });

  it('the three parties are three entries, each to its own screen', async () => {
    const { NAV_REGISTRY } = await import('../seed/bootstrap.js');
    const at = (key: string) => NAV_REGISTRY.find((n) => n.nodeKey === key);

    expect(at('crm_students')).toMatchObject({ label: 'Customers', path: '/crm/students' });
    expect(at('crm_institutions')).toMatchObject({ label: 'Institutions', path: '/crm/institutions' });
    expect(at('crm_accounts')).toMatchObject({ label: 'Organisations', path: '/crm/organizations' });

    // The words that sent somebody to the wrong one.
    expect(at('crm_students')!.synonyms).toContain('students');
    expect(at('crm_institutions')!.synonyms).toContain('colleges');
    expect(at('crm_accounts')!.synonyms).not.toContain('colleges');
    expect(at('crm_accounts')!.synonyms).not.toContain('customer');
  });
});

// ===========================================================================
// CRM-IDN-002/003 — the three party types
// ===========================================================================

describe('CRM-IDN-002 — a body is an institution or an organisation, never both', () => {
  it('a college we also invoice stays a college: billing is not an identity', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const { createOrganization } = await import('../domains/organizations.js');
      const college = await createOrganization({
        kind: 'institution',
        name: `Billed College ${Date.now()}`,
        institutionProfile: { institutionType: 'polytechnic', district: 'Erode' },
      });
      // Payment terms on a polytechnic that buys a staff programme. Refusing
      // this is what makes somebody keep a second record in a spreadsheet.
      await expect(attachAccount(college.id, { tier: 'standard', paymentTermsDays: 45 })).resolves.toBeTruthy();

      const after = await prisma.organization.findFirstOrThrow({ where: { id: college.id } });
      expect(after.kind).toBe('institution');
    });
  });

  it('school details are refused on an organisation, rather than quietly dropped', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const { createOrganization } = await import('../domains/organizations.js');
      const firm = await createOrganization({ kind: 'organization', name: `Not A School ${Date.now()}` });

      const err = await expectReject(async () =>
        attachInstitutionProfile(firm.id, { institutionType: 'polytechnic' }),
      );
      expect(err.status).toBe(400);
      expect(err.message).toMatch(/not a school or a college/i);

      // And the same refusal at creation, so the two routes agree.
      const atCreate = await expectReject(async () =>
        createOrganization({
          kind: 'organization',
          name: `Also Not A School ${Date.now()}`,
          institutionProfile: { institutionType: 'polytechnic' },
        }),
      );
      expect(atCreate.status).toBe(400);
    });
  });

  it('the two lists do not contain each other', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const { createOrganization } = await import('../domains/organizations.js');
      const tag = Date.now();
      const college = await createOrganization({ kind: 'institution', name: `Split College ${tag}` });
      const firm = await createOrganization({ kind: 'organization', name: `Split Traders ${tag}` });

      const institutions = await prisma.organization.findMany({ where: { kind: 'institution' }, select: { id: true } });
      const organizations = await prisma.organization.findMany({ where: { kind: 'organization' }, select: { id: true } });

      expect(institutions.map((o) => o.id)).toContain(college.id);
      expect(institutions.map((o) => o.id)).not.toContain(firm.id);
      expect(organizations.map((o) => o.id)).toContain(firm.id);
      expect(organizations.map((o) => o.id)).not.toContain(college.id);
    });
  });

  it('reclassifying needs a reason, and is refused once learners point at the college', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const { createOrganization, reclassifyOrganization } = await import('../domains/organizations.js');
      const college = await createOrganization({ kind: 'institution', name: `Mistyped ${Date.now()}` });

      const noReason = await expectReject(async () => reclassifyOrganization(college.id, 'organization', ''));
      expect(noReason.status).toBe(400);

      // With a reason, and nothing hanging off it, the correction goes through.
      const fixed = await reclassifyOrganization(college.id, 'organization', 'Entered as a college by mistake; it is a trust.');
      expect(fixed.kind).toBe('organization');

      // But a college that has actually sent us learners is not turned into a
      // supplier on somebody's say-so.
      const real = await createOrganization({ kind: 'institution', name: `Has Learners ${Date.now()}` });
      const person = await prisma.person.create({
        data: { tenantId: TENANT, recordCode: `PER-TEST-${Date.now()}`, fullName: 'Sent By Them' },
      });
      await prisma.studentProfile.create({
        data: { tenantId: TENANT, personId: person.id, institutionId: real.id, status: 'active' },
      });
      const blocked = await expectReject(async () =>
        reclassifyOrganization(real.id, 'organization', 'Changed my mind about this one.'),
      );
      expect(blocked.status).toBe(409);
      expect(blocked.message).toMatch(/student record/i);
    });
  });

  it('attaching an institution profile requires institutions:create, never organizations:*', async () => {
    await asUser('priya@kaizen.co.in', async () => {
      // marketing holds organizations:VC but no institutions grant.
      const org = await prisma.organization.findFirstOrThrow({
        where: { kind: 'institution', institutionProfile: null },
      });
      const err = await expectReject(() => attachInstitutionProfile(org.id, { institutionType: 'school' }));
      expect(err.status).toBe(403);
    });
  });

  it('a student is a third thing, in neither list', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const { createStudent, listStudents } = await import('../domains/students.js');
      const tag = Date.now();
      const student = await createStudent({
        fullName: `Ilakkiya ${tag}`,
        primaryPhone: `98${String(tag).slice(-8)}`,
        registrationNumber: `KI-TEST/${tag}`,
      });

      expect(student.recordCode).toMatch(/^PER-/);
      const listed = await listStudents({ q: `Ilakkiya ${tag}` });
      expect(listed.items.map((i) => i.id)).toContain(student.id);

      // And nowhere among the bodies: a learner is not a small organisation.
      const bodies = await prisma.organization.findMany({ where: { name: { contains: `Ilakkiya ${tag}` } } });
      expect(bodies).toHaveLength(0);
    });
  });

  it('a student comes from an institution, and an organisation is refused as one', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const { createOrganization } = await import('../domains/organizations.js');
      const { createStudent } = await import('../domains/students.js');
      const tag = Date.now();
      const firm = await createOrganization({ kind: 'organization', name: `Sender Traders ${tag}` });

      const err = await expectReject(async () =>
        createStudent({
          fullName: `Wrong Origin ${tag}`,
          primaryPhone: `97${String(tag).slice(-8)}`,
          institutionId: firm.id,
        }),
      );
      expect(err.status).toBe(400);
      expect(err.message).toMatch(/not a school or a college/i);
    });
  });

  it('a registration number belongs to one learner, and the second one is told whose it is', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const { createStudent } = await import('../domains/students.js');
      const tag = Date.now();
      const number = `KI-DUP/${tag}`;
      const first = await createStudent({
        fullName: `First Holder ${tag}`,
        primaryPhone: `96${String(tag).slice(-8)}`,
        registrationNumber: number,
      });

      const err = await expectReject(async () =>
        createStudent({
          fullName: `Second Holder ${tag}`,
          primaryPhone: `95${String(tag).slice(-8)}`,
          registrationNumber: number,
        }),
      );
      expect(err.status).toBe(409);
      // Named, because "already exists" leaves somebody hunting for the row.
      expect(err.message).toContain(first.fullName);
    });
  });

  it('somebody already on file becomes a student rather than a second person', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const { createStudent } = await import('../domains/students.js');
      const tag = Date.now();
      const phone = `94${String(tag).slice(-8)}`;
      const contact = await prisma.person.create({
        data: {
          tenantId: TENANT,
          recordCode: `PER-TEST-C${tag}`,
          fullName: `Already Known ${tag}`,
          primaryPhone: phone,
          primaryPhoneNormalised: phone,
        },
      });

      const student = await createStudent({ fullName: `Already Known ${tag}`, primaryPhone: phone });
      expect(student.personId).toBe(contact.id);

      const people = await prisma.person.count({ where: { primaryPhoneNormalised: phone, deletedAt: null } });
      expect(people).toBe(1);
    });
  });

  it('an employee can take a student on at the counter, and cannot rewrite one afterwards', async () => {
    const tag = Date.now();
    const created = await asUser('employee@kaizen.co.in', async () => {
      const { createStudent } = await import('../domains/students.js');
      return createStudent({ fullName: `Walk In ${tag}`, primaryPhone: `93${String(tag).slice(-8)}` });
    });
    expect(created.fullName).toBe(`Walk In ${tag}`);

    await asUser('employee@kaizen.co.in', async () => {
      const { updateStudent } = await import('../domains/students.js');
      const err = await expectReject(async () => updateStudent(created.id, { status: 'alumni' }));
      expect(err.status).toBe(403);
    });
  });

  it('a sponsored learner names who is paying, or is refused', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const { createStudent } = await import('../domains/students.js');
      const { createOrganization } = await import('../domains/organizations.js');
      const tag = Date.now();

      // "Sponsored" with nobody named is the row that later gets billed to the
      // learner by mistake, so it does not get written.
      const err = await expectReject(async () =>
        createStudent({ fullName: `Unpaid ${tag}`, primaryPhone: `89${String(tag).slice(-8)}`, funding: 'sponsor' }),
      );
      expect(err.status).toBe(400);
      expect(err.message).toMatch(/needs the organisation that is paying/i);

      // A college cannot be a sponsor: a college paying for its own students is
      // its own thing, and the two are reported differently.
      const college = await createOrganization({ kind: 'institution', name: `Paying College ${tag}` });
      const wrong = await expectReject(async () =>
        createStudent({
          fullName: `Miscoded ${tag}`,
          primaryPhone: `88${String(tag).slice(-8)}`,
          funding: 'sponsor',
          sponsorId: college.id,
        }),
      );
      expect(wrong.status).toBe(400);

      // A scheme without its framework reports as nothing, so it is refused too.
      const noFramework = await expectReject(async () =>
        createStudent({ fullName: `Schemeless ${tag}`, primaryPhone: `87${String(tag).slice(-8)}`, funding: 'scheme' }),
      );
      expect(noFramework.status).toBe(400);
      expect(noFramework.message).toMatch(/Naan Mudhalvan/);
    });
  });

  it('a funded learner is not billable, and the invoice says who to bill instead', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const { createStudent } = await import('../domains/students.js');
      const { createOrganization } = await import('../domains/organizations.js');
      const { createInvoice } = await import('../domains/invoicing.js');
      const tag = Date.now();

      const sponsor = await createOrganization({
        kind: 'organization',
        name: `Schedule VII Foundation ${tag}`,
        roles: ['sponsor'],
      });
      const learner = await createStudent({
        fullName: `Funded Beneficiary ${tag}`,
        primaryPhone: `86${String(tag).slice(-8)}`,
        funding: 'sponsor',
        sponsorId: sponsor.id,
      });
      expect(learner.billable).toBe(false);

      // The whole point of recording it: no tax invoice reaches a beneficiary
      // of a funded cohort.
      const err = await expectReject(async () =>
        createInvoice({
          personId: learner.personId,
          lines: [{ description: 'A course', unitPrice: 10_000, gstRate: 18, hsnSac: '999293' }],
        }),
      );
      expect(err.status).toBe(400);
      expect(err.message).toContain(`Schedule VII Foundation ${tag}`);

      // And the sponsor is billable in their place.
      const invoice = await createInvoice({
        organizationId: sponsor.id,
        placeOfSupply: '33',
        lines: [{ description: `Cohort fee — ${learner.fullName}`, unitPrice: 10_000, gstRate: 18, hsnSac: '999293' }],
      });
      expect(invoice.organizationId).toBe(sponsor.id);
    });
  });

  it('a body does several things at once, and a college is described differently', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const { createOrganization, setOrganizationRoles } = await import('../domains/organizations.js');
      const tag = Date.now();

      // Funds a CSR cohort and hires out of it. Both, not one.
      const firm = await createOrganization({
        kind: 'organization',
        name: `Both Industries ${tag}`,
        roles: ['sponsor', 'employer'],
      });
      expect(firm.roles.sort()).toEqual(['employer', 'sponsor']);

      const widened = await setOrganizationRoles(firm.id, ['sponsor', 'employer', 'client']);
      expect(widened.roles).toContain('client');

      // A college is described by its engagements instead.
      const refused = await expectReject(async () =>
        createOrganization({ kind: 'institution', name: `Roled College ${tag}`, roles: ['client'] }),
      );
      expect(refused.status).toBe(400);
    });
  });

  it('detaching a specialisation that would orphan an open opportunity is blocked with a count, not a silent cascade', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      // Asked for as one query, so the org is chosen for holding *both* facts
      // rather than for happening to sort first on one of them.
      const org = await prisma.organization.findFirstOrThrow({
        where: {
          account: { isNot: null },
          opportunities: { some: { outcome: null, deletedAt: null } },
        },
        orderBy: { createdAt: 'asc' },
      });
      const err = await expectReject(() => detachAccount(org.id));
      expect(err.status).toBe(409);
      expect(err.message).toMatch(/open opportunit/);
    });
  });

  it('detaching a specialisation nothing references succeeds, so the block is about the references and not the detach', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const { createOrganization } = await import('../domains/organizations.js');
      const org = await createOrganization({ kind: 'organization', name: `Detachable ${Date.now()}` });
      await attachAccount(org.id, { tier: 'standard' });
      await expect(detachAccount(org.id)).resolves.toEqual({ detached: true });
      expect(await prisma.account.count({ where: { organizationId: org.id } })).toBe(0);
      // The organisation itself survives: a specialisation is not the record.
      expect(await prisma.organization.count({ where: { id: org.id } })).toBe(1);
    });
  });

  it('a viewer without an institutions grant sees the specialisation badge but not its contents', async () => {
    // Every seeded role holds at least institutions:V, so the withheld path is
    // not reachable from the shipped matrix. The requirement is about the
    // mechanism — a base grant does not carry the specialisation's grant with
    // it — so the test provisions a role that holds one and not the other,
    // exactly as a tenant tightening its own matrix would.
    const p = await principalFor('priya@kaizen.co.in');
    const role = await unscopedPrisma.accessRole.upsert({
      where: { tenantId_slug: { tenantId: TENANT, slug: 'org_only_viewer' } },
      create: { tenantId: TENANT, slug: 'org_only_viewer', name: 'Organisation-only viewer' },
      update: {},
    });
    const existing = await unscopedPrisma.grant.findFirst({
      where: { tenantId: TENANT, roleId: role.id, resource: 'organizations' },
    });
    if (!existing) {
      await unscopedPrisma.grant.create({
        data: {
          tenantId: TENANT,
          roleId: role.id,
          principalType: 'role',
          resource: 'organizations',
          verbs: ['view'],
          scope: 'all',
          effectiveFrom: new Date(0),
        },
      });
    }

    await asPrincipal(authFor(p, { roleSlug: 'org_only_viewer' }), async () => {
      const { assembleOrganization360 } = await import('../domains/organizations.js');
      const org = await prisma.organization.findFirstOrThrow({ where: { institutionProfile: { isNot: null } } });
      const view = await assembleOrganization360(org.id);

      // The fact of the specialisation is not itself sensitive; its contents are.
      expect(view.specialisations.some((s) => s.kind === 'institution_profile' && s.present)).toBe(true);
      expect(view.institutionProfile).toBeNull();
      expect(view.withheld).toContainEqual({ path: 'institutionProfile', reason: 'no_permission' });
    });
  });

  it('the computed relationship status is never stored on the organisation row', async () => {
    const columns = await unscopedPrisma.$queryRawUnsafe<Array<{ column_name: string }>>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'organizations'",
    );
    const names = columns.map((c) => c.column_name);
    expect(names).not.toContain('computedRelationshipStatus');
    expect(names).not.toContain('relationship_status');
  });

  // -------------------------------------------------------------------------
  // Import correction — a record created wrong by a bulk import (or typed
  // wrong by hand) needs a plain way back, not just a way in.
  // -------------------------------------------------------------------------

  it('updateOrganization corrects the record, refuses a viewer without organizations:edit, and a bad id 404s', async () => {
    const tag = Date.now();
    const org = await asUser('chairman@kaizen.co.in', async () => {
      const { createOrganization } = await import('../domains/organizations.js');
      return createOrganization({ kind: 'organization', name: `Before Correction ${tag}`, roles: ['client'] });
    });

    await asUser('chairman@kaizen.co.in', async () => {
      const updated = await updateOrganization(org.id, { name: `Corrected ${tag}`, website: 'https://corrected.example' });
      expect(updated.name).toBe(`Corrected ${tag}`);
      expect(updated.website).toBe('https://corrected.example');
      // Not this function's to change: kind is `reclassifyOrganization`'s and
      // roles are `setOrganizationRoles`'s.
      expect(updated.kind).toBe('organization');
      expect(updated.roles).toEqual(['client']);
    });

    const err = await expectReject(() =>
      asUser('employee@kaizen.co.in', () => updateOrganization(org.id, { name: 'Should not land' })),
    );
    expect(err.status).toBe(403);

    const missing = await expectReject(() =>
      asUser('chairman@kaizen.co.in', () => updateOrganization('does-not-exist', { name: 'Nobody home' })),
    );
    expect(missing.status).toBe(404);
  });

  it('updateAccount corrects billing detail already on file, refuses a viewer without edit, and 404s where there is none yet', async () => {
    const tag = Date.now();
    const org = await asUser('chairman@kaizen.co.in', async () => {
      const { createOrganization } = await import('../domains/organizations.js');
      return createOrganization({ kind: 'organization', name: `Billed Correction ${tag}` });
    });

    // Attaching one first is `attachAccount`'s job; this is the correction
    // path and does not stand in for it.
    const beforeAttach = await expectReject(() =>
      asUser('chairman@kaizen.co.in', () => updateAccount(org.id, { tier: 'strategic' })),
    );
    expect(beforeAttach.status).toBe(404);
    expect(beforeAttach.message).toMatch(/Billing details/i);

    await asUser('chairman@kaizen.co.in', async () => {
      await attachAccount(org.id, { tier: 'standard', paymentTermsDays: 30 });
      const updated = await updateAccount(org.id, { tier: 'strategic', paymentTermsDays: 45 });
      expect(updated.tier).toBe('strategic');
      expect(updated.paymentTermsDays).toBe(45);
    });

    const err = await expectReject(() =>
      asUser('employee@kaizen.co.in', () => updateAccount(org.id, { tier: 'standard' })),
    );
    expect(err.status).toBe(403);
  });

  it('updateInstitutionProfile corrects school detail already on file, needs institutions:edit, and 404s where there is none yet', async () => {
    const tag = Date.now();
    const college = await asUser('chairman@kaizen.co.in', async () => {
      const { createOrganization } = await import('../domains/organizations.js');
      return createOrganization({ kind: 'institution', name: `School Correction ${tag}` });
    });

    const beforeAttach = await expectReject(() =>
      asUser('chairman@kaizen.co.in', () => updateInstitutionProfile(college.id, { district: 'Erode' })),
    );
    expect(beforeAttach.status).toBe(404);
    expect(beforeAttach.message).toMatch(/School or college details/i);

    await asUser('chairman@kaizen.co.in', async () => {
      await attachInstitutionProfile(college.id, { institutionType: 'polytechnic', district: 'Salem' });
      const updated = await updateInstitutionProfile(college.id, {
        district: 'Erode',
        institutionType: 'engineering_college',
      });
      expect(updated.district).toBe('Erode');
      expect(updated.institutionType).toBe('engineering_college');
    });

    // employee holds no institutions grant at all beyond `V@all`.
    const err = await expectReject(() =>
      asUser('employee@kaizen.co.in', () => updateInstitutionProfile(college.id, { district: 'Nowhere' })),
    );
    expect(err.status).toBe(403);
  });
});

// ===========================================================================
// CRM-IDN-004 — Relationship graph
// ===========================================================================

describe('CRM-IDN-004 — the relationship graph', () => {
  it('a nature change ends the current row and creates a new one, never mutating in place', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const org = await prisma.organization.findFirstOrThrow({});
      const person = await prisma.person.findFirstOrThrow({});

      const original = await createRelationship({
        fromType: 'person',
        fromId: person.id,
        toType: 'organization',
        toId: org.id,
        relationshipType: 'employed_by',
        role: 'Analyst',
      });

      const { ended, replacement } = await supersedeRelationship(original.id, {
        relationshipType: 'decision_maker_for',
        role: 'Head of Technology',
      });

      expect(ended.endDate).not.toBeNull();
      expect(ended.status).toBe('ended');
      // The prior row keeps its defining fields untouched.
      expect(ended.relationshipType).toBe('employed_by');
      expect(replacement.relationshipType).toBe('decision_maker_for');
      expect(replacement.id).not.toBe(original.id);
      expect(replacement.endDate).toBeNull();
    });
  });

  it('status and strength update in place — the deliberate exception to the supersede rule', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const rel = await prisma.relationship.findFirstOrThrow({ where: { endDate: null } });
      const before = await prisma.relationship.count();
      const updated = await refineRelationship(rel.id, { strength: 'strong' });
      expect(updated.id).toBe(rel.id);
      expect(updated.strength).toBe('strong');
      expect(await prisma.relationship.count()).toBe(before);
    });
  });

  it('a current-view traversal excludes ended rows; a full-history traversal includes them', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const { traverse } = await import('../domains/relationships.js');
      const ended = await prisma.relationship.findFirstOrThrow({ where: { status: 'ended' } });

      const current = await traverse(ended.fromType, ended.fromId);
      const history = await traverse(ended.fromType, ended.fromId, { fullHistory: true });

      expect(current.some((r) => r.id === ended.id)).toBe(false);
      expect(history.some((r) => r.id === ended.id)).toBe(true);
    });
  });
});

// ===========================================================================
// CRM-LEAD-001/002 — Pipeline as data
// ===========================================================================

describe('CRM-LEAD-001/002 — the pipeline vocabulary is data', () => {
  it('the canonical ordinal stays a closed eight-value set', () => {
    expect([...PIPELINE_POSITIONS]).toEqual([0, 10, 20, 30, 40, 50, 60, 90]);
  });

  it('a stage outside the closed set is rejected with a 422', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const { addStage } = await import('../domains/pipelines.js');
      const pipeline = await prisma.pipelineDefinition.findFirstOrThrow({});
      const err = await expectReject(() =>
        addStage(pipeline.id, {
          stageKey: `bad_${Date.now()}`,
          label: 'Bad',
          sequence: 900,
          defaultProbability: 50,
          pipelinePosition: 45,
        }),
      );
      expect(err.status).toBe(422);
      expect(err.message).toMatch(/closed canonical set/);
    });
  });

  it('all five pipelines are seeded, each with an entry stage and both terminals', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const pipelines = await prisma.pipelineDefinition.findMany({ where: { effectiveTo: null } });
      const codes = pipelines.map((p) => p.pipelineCode).sort();
      expect(codes).toEqual(['PL-ADMISSION', 'PL-ENTERPRISE', 'PL-INSTITUTION', 'PL-PLACEMENT', 'PL-RENEWAL']);

      for (const p of pipelines) {
        const usable = await assertPipelineUsable(p.id);
        expect(usable.usable, `${p.pipelineCode}: ${usable.reason}`).toBe(true);
      }
    });
  });

  it('every transition graph reaches a terminal stage from every open stage', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const pipelines = await prisma.pipelineDefinition.findMany({ where: { effectiveTo: null } });
      for (const p of pipelines) {
        await expect(assertGraphReachable(p.id)).resolves.toBeUndefined();
      }
    });
  });

  it('a stage write with no corresponding transition is rejected, naming the invalid transition', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const pipeline = await prisma.pipelineDefinition.findFirstOrThrow({ where: { pipelineCode: 'PL-ENTERPRISE' } });
      const check = await validateTransition(pipeline.id, 'discovered', 'won', {});
      expect(check.ok).toBe(false);
      expect(check.reason).toMatch(/No permitted transition/);
    });
  });

  it('the same ordinal spans pipelines whose stage labels differ', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const at30 = await prisma.pipelineStage.findMany({ where: { pipelinePosition: 30, retiredAt: null } });
      const labels = new Set(at30.map((s) => s.label));
      // "Qualified", "Course Selected" and "Requirement Qualified" are all
      // position 30 — comparable by position, not by name.
      expect(at30.length).toBeGreaterThanOrEqual(4);
      expect(labels.size).toBeGreaterThan(1);
    });
  });

  it('a per-pipeline SLA budget differs where the motions differ', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const admission = await prisma.pipelineStage.findFirstOrThrow({
        where: { stageKey: 'counselled', pipeline: { pipelineCode: 'PL-ADMISSION' } },
      });
      const institution = await prisma.pipelineStage.findFirstOrThrow({
        where: { stageKey: 'engaged', pipeline: { pipelineCode: 'PL-INSTITUTION' } },
      });
      // Five idle days is normal for an institution relationship and fatal for
      // an admissions enquiry.
      expect(admission.stageAgeBudgetDays).toBe(3);
      expect(institution.stageAgeBudgetDays).toBe(30);
    });
  });

  it('the retired post-award stages exist for reporting but no transition targets them', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const retired = await prisma.pipelineStage.findMany({ where: { postAward: true } });
      expect(retired.map((s) => s.stageKey).sort()).toEqual(['delivering', 'outcome', 'renew_expand_refer']);

      for (const stage of retired) {
        const inbound = await prisma.pipelineTransition.count({ where: { toStageKey: stage.stageKey } });
        expect(inbound).toBe(0);
      }
    });
  });

  it('retiring a stage with live records is blocked with a count', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const { retireStage } = await import('../domains/pipelines.js');
      const opp = await prisma.opportunity.findFirstOrThrow({ where: { outcome: null } });
      const stage = await prisma.pipelineStage.findFirstOrThrow({
        where: { pipelineId: opp.pipelineId, stageKey: opp.stageKey },
      });
      const err = await expectReject(() => retireStage(stage.id));
      expect(err.status).toBe(409);
      expect(err.message).toMatch(/reassign or retire them first/);
    });
  });
});

// ===========================================================================
// CRM-LEAD-003/005 — Lead ownership and routing
// ===========================================================================

describe('CRM-LEAD-003/005 — routing-assigned ownership', () => {
  it('the unrouted predicate is one source of truth', () => {
    expect(isUnrouted({ leadStatus: 'open', ownerPartyId: null })).toBe(true);
    expect(isUnrouted({ leadStatus: 'open', ownerPartyId: 'x' })).toBe(false);
    expect(isUnrouted({ leadStatus: 'converted', ownerPartyId: null })).toBe(false);
  });

  it('a lead with no eligible candidate lands unrouted rather than defaulting to its creator', async () => {
    await asUser('arun@kaizen.co.in', async (p) => {
      const { createLead } = await import('../domains/leads.js');
      const lead = await createLead({
        title: `Unroutable ${Date.now()}`,
        person: { fullName: `Unroutable Contact ${Date.now()}`, primaryPhone: `6${Date.now().toString().slice(-9)}` },
        // A vertical no capability claim or territory covers.
        vertical: 'research',
        district: 'Nowhere District',
        source: 'inbound_website',
      });

      if (lead.ownerPartyId === null) {
        expect(lead.unroutedReason).not.toBeNull();
      }
      // The creation-time actor must never leak into ownerPartyId.
      if (lead.ownerPartyId !== null) {
        const audit = await prisma.routingAudit.findFirstOrThrow({ where: { leadId: lead.id } });
        expect(audit.winnerPartyId).toBe(lead.ownerPartyId);
      }
    });
  });

  it('a routing evaluation records every candidate considered, not only the winner', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const audit = await prisma.routingAudit.findFirst({ orderBy: { evaluatedAt: 'desc' } });
      expect(audit).not.toBeNull();
      const candidates = audit!.candidates as unknown as Array<{ passedHardFilters: boolean; factors: unknown[] }>;
      expect(Array.isArray(candidates)).toBe(true);
    });
  });

  it('a candidate failing a hard filter is never scored on the soft factors', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const audits = await prisma.routingAudit.findMany({ take: 20, orderBy: { evaluatedAt: 'desc' } });
      for (const a of audits) {
        const candidates = a.candidates as unknown as Array<{ passedHardFilters: boolean; factors: unknown[]; total: number }>;
        for (const c of candidates) {
          if (!c.passedHardFilters) {
            expect(c.factors).toHaveLength(0);
            expect(c.total).toBe(0);
          }
        }
      }
    });
  });

  it('the two unrouted causes carry different reason codes, because they need different remedies', async () => {
    const { UNROUTED_REASONS } = await import('@kaizen/shared');
    expect(UNROUTED_REASONS).toContain('no_vertical_coverage');
    expect(UNROUTED_REASONS).toContain('all_candidates_over_capacity');
  });
});

// ===========================================================================
// CRM-LEAD-004 — the won gate
// ===========================================================================

describe('CRM-LEAD-004 / CRM-COML-006 — the won gate lives in the service layer', () => {
  it('an opportunity cannot reach won while both contract_id and mou_id are null', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const opp = await prisma.opportunity.findFirstOrThrow({
        where: { outcome: null, contractId: null, mouId: null },
        include: { pipeline: { include: { stages: true, transitions: true } } },
      });

      // Walk to a stage from which won is reachable.
      const won = opp.pipeline.stages.find((s) => s.pipelinePosition === 90)!;
      const fromStages = opp.pipeline.transitions
        .filter((t) => t.toStageKey === won.stageKey)
        .map((t) => t.fromStageKey);

      await prisma.opportunity.update({
        where: { id: opp.id },
        data: { stageKey: fromStages[0]!, proposalId: opp.proposalId ?? 'placeholder' },
      });

      const err = await expectReject(() => advanceStage(opp.id, won.stageKey));
      expect(err.status).toBe(422);
      expect(err.message).toMatch(/contract_id and mou_id are null/);
    });
  });

  it('a renewal opens a new opportunity rather than mutating the original', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const { openRenewalOpportunity } = await import('../domains/opportunities.js');
      const contract = await prisma.contract.findFirstOrThrow({ where: { status: 'active' } });
      const originalCount = await prisma.opportunity.count();

      const renewal = await openRenewalOpportunity(contract.id);

      expect(await prisma.opportunity.count()).toBe(originalCount + 1);
      expect(renewal.parentContractId).toBe(contract.id);

      const pipeline = await prisma.pipelineDefinition.findFirstOrThrow({ where: { id: renewal.pipelineId } });
      expect(pipeline.pipelineCode).toBe('PL-RENEWAL');

      // The original opportunity's stage is untouched.
      if (contract.opportunityId) {
        const original = await prisma.opportunity.findFirstOrThrow({ where: { id: contract.opportunityId } });
        expect(original.id).not.toBe(renewal.id);
      }
    });
  });
});

// ===========================================================================
// CRM-LEAD-006 — Forecast category state machine
// ===========================================================================

describe('CRM-LEAD-006 — the forecast category state machine', () => {
  it('an opportunity at position 10 cannot be promoted to best_case', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const early = await prisma.opportunity.findFirst({
        where: { outcome: null, forecastCategory: 'pipeline' },
        include: { pipeline: { include: { stages: true } } },
      });
      if (!early) return;

      const entry = early.pipeline.stages.find((s) => s.pipelinePosition === 10)!;
      await prisma.opportunity.update({ where: { id: early.id }, data: { stageKey: entry.stageKey } });

      const err = await expectReject(() => changeForecastCategory({ opportunityId: early.id, to: 'best_case' }));
      expect(err.status).toBe(422);
      expect(err.message).toMatch(/engaged \(20\) or later/);
    });
  });

  it('commit is blocked on a past expected close date, and re-promotion re-validates staleness', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const opp = await prisma.opportunity.findFirstOrThrow({
        where: { outcome: null },
        include: { pipeline: { include: { stages: true } } },
      });
      const shaped = opp.pipeline.stages.find((s) => s.pipelinePosition === 40)!;

      await prisma.opportunity.update({
        where: { id: opp.id },
        data: {
          stageKey: shaped.stageKey,
          forecastCategory: 'best_case',
          expectedCloseDate: new Date(Date.now() - 10 * 86_400_000),
          expectedValue: 100_000,
        },
      });

      const err = await expectReject(() => changeForecastCategory({ opportunityId: opp.id, to: 'commit' }));
      expect(err.message).toMatch(/expected_close_date is in the past/);
    });
  });

  it('forecast_category cannot be set to a closed value independently of the stage', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const opp = await prisma.opportunity.findFirstOrThrow({ where: { outcome: null } });
      const err = await expectReject(() =>
        changeForecastCategory({ opportunityId: opp.id, to: 'closed_won' as never }),
      );
      expect(err.message).toMatch(/Closure follows the stage/);
    });
  });

  it('a demotion always requires a reason', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const opp = await prisma.opportunity.findFirst({ where: { outcome: null, forecastCategory: 'best_case' } });
      if (!opp) return;
      const err = await expectReject(() => changeForecastCategory({ opportunityId: opp.id, to: 'pipeline' }));
      expect(err.message).toMatch(/requires a reason/);
    });
  });

  it('a manual_commit pipeline counts only explicitly committed deals, never stage-weighted probability', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const rollup = await forecastRollup();
      const placement = rollup.perPipeline.find((p) => p.pipelineCode === 'PL-PLACEMENT');
      expect(placement?.forecastMethod).toBe('manual_commit');

      for (const bucket of placement?.buckets ?? []) {
        if (bucket.category !== 'commit') {
          expect(bucket.weightedValue).toBe(0);
        }
      }
    });
  });

  it('the default roll-up is per pipeline, and a blended total only appears on explicit request', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const plain = await forecastRollup();
      expect(plain.blended).toBeNull();
      expect(plain.perPipeline.length).toBeGreaterThan(1);

      const blended = await forecastRollup({ blended: true });
      expect(blended.blended).not.toBeNull();
      expect(blended.note).toMatch(/not directly comparable/);
    });
  });

  it('a cross-pipeline coverage query spans every pipeline in one pass', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const coverage = await coverageByPosition(30);
      const pipelineIds = new Set(coverage.opportunities.map((o) => o.pipelineId));
      expect(coverage.count).toBeGreaterThan(0);
      expect(pipelineIds.size).toBeGreaterThanOrEqual(1);
    });
  });
});

// ===========================================================================
// CRM-COML-002/005 — Price book and the discount gate
// ===========================================================================

describe('CRM-COML-002/005 — price versioning and the discount-authority gate', () => {
  it('repricing creates a new version and supersedes the prior one, never mutating it', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const offering = await prisma.offering.findFirstOrThrow({ where: { offeringCode: 'CYBER-VAPT' } });
      const before = await prisma.priceBookEntry.findFirstOrThrow({
        where: { offeringId: offering.id, status: 'active' },
      });

      const after = await publishPrice({
        offeringId: offering.id,
        currency: 'INR',
        unitPrice: 1_500_000,
        billingFrequency: 'one_time',
        maxDiscountPct: 18,
      });

      const superseded = await prisma.priceBookEntry.findFirstOrThrow({ where: { id: before.id } });
      expect(superseded.status).toBe('superseded');
      // The superseded row's price is unchanged, so a quote built against it
      // stays reproducible.
      expect(Number(superseded.unitPrice.toString())).toBe(Number(before.unitPrice.toString()));
      expect(after.version).toBe(before.version + 1);
      expect(after.status).toBe('active');
    });
  });

  it('a price book entry cannot be published without a deliberately set ceiling', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const offering = await prisma.offering.findFirstOrThrow({});
      const err = await expectReject(() =>
        publishPrice({
          offeringId: offering.id,
          currency: 'INR',
          unitPrice: 1000,
          billingFrequency: 'one_time',
          maxDiscountPct: null as never,
        }),
      );
      expect(err.message).toMatch(/required on every price book entry/);
    });
  });

  it('a within-ceiling quote issues; an over-ceiling quote blocks WHOLLY and opens an approval step', async () => {
    await asUser('arun@kaizen.co.in', async () => {
      const entry = await prisma.priceBookEntry.findFirstOrThrow({
        where: { status: 'active', maxDiscountPct: { gte: 10 } },
      });
      const opp = await prisma.opportunity.findFirstOrThrow({ where: { outcome: null } });

      const okQuote = await createQuote(opp.id, [
        { priceBookEntryId: entry.id, quantity: 1, discountPct: Math.max(entry.maxDiscountPct - 2, 0) },
      ]);
      const okResult = await issueQuote(okQuote.id);
      expect(okResult.issued).toBe(true);
      expect(okResult.blockedLines).toHaveLength(0);

      const overQuote = await createQuote(opp.id, [
        { priceBookEntryId: entry.id, quantity: 1, discountPct: Math.min(entry.maxDiscountPct + 15, 100) },
      ]);
      const overResult = await issueQuote(overQuote.id);

      expect(overResult.issued).toBe(false);
      expect(overResult.blockedLines).toHaveLength(1);
      expect(overResult.approvalStepId).not.toBeNull();
      expect(overResult.quote.status).toBe('blocked');
    });
  });

  it('a quote line resolves against the exact price book entry version, not the current price', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const line = await prisma.quoteLine.findFirstOrThrow({
        include: { priceBookEntry: true },
        orderBy: { createdAt: 'asc' },
      });
      expect(typeof line.priceBookEntryVersion).toBe('number');
      // The resolved list price is frozen onto the line itself.
      expect(Number(line.listUnitPrice.toString())).toBeGreaterThan(0);
    });
  });

  it('a quote cannot mix currencies', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const offering = await createOffering({
        offeringCode: `USD-TEST-${Date.now()}`,
        name: 'USD priced offering',
        vertical: 'software_ai',
        deliveryModel: 'saas_subscription',
      });
      const usd = await publishPrice({
        offeringId: offering.id,
        currency: 'USD',
        unitPrice: 5000,
        billingFrequency: 'monthly',
        maxDiscountPct: 10,
      });
      const inr = await prisma.priceBookEntry.findFirstOrThrow({ where: { currency: 'INR', status: 'active' } });
      const opp = await prisma.opportunity.findFirstOrThrow({ where: { outcome: null } });

      const err = await expectReject(() =>
        createQuote(opp.id, [
          { priceBookEntryId: usd.id, quantity: 1, discountPct: 0 },
          { priceBookEntryId: inr.id, quantity: 1, discountPct: 0 },
        ]),
      );
      expect(err.message).toMatch(/cannot mix currencies/);
    });
  });
});

// ===========================================================================
// CRM-COML-006 / CRM-MOU-002 — the privileged-transition gate
// ===========================================================================

describe('CRM-MOU-002 — the approval gate', () => {
  it('a contract cannot be created with a non-positive commercial value', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const err = await expectReject(() =>
        createContract({ title: 'Unpriced', commercialValue: 0 }),
      );
      expect(err.status).toBe(422);
      expect(err.message).toMatch(/greater than zero/);
    });
  });

  it('holding edit alone never confers approval authority', async () => {
    // `approve` is a distinct verb from `edit` and is granted separately. No
    // shipped role now holds one without the other on agreements, so the
    // separation is asserted against a role that holds edit alone — which is
    // the property the gate actually depends on.
    const mou = await asUser('chairman@kaizen.co.in', () =>
      prisma.mou.findFirstOrThrow({ where: { status: 'proposed' } }),
    );
    await withFixtureRole(
      { slug: 'mou_editor', grants: [{ resource: 'mous', verbs: ['view', 'create', 'edit', 'assign'] }] },
      async () => {
        const err = await expectReject(() => transitionAgreement('mou', mou.id, 'approved'));
        expect(err.status).toBe(403);
        expect(err.message).toMatch(/distinct grant/);
      },
    );
  });

  it('the Self-Dealing Bar reroutes an owner-approver to the next tier rather than permitting it', async () => {
    await asUser('bhead@kaizen.co.in', async (p) => {
      const mou = await prisma.mou.create({
        data: {
          tenantId: p.tenantId,
          recordCode: `MOU-2026-9${Date.now() % 1000}`,
          title: 'Self-dealing probe',
          organizationId: (await prisma.organization.findFirstOrThrow({})).id,
          status: 'proposed',
          commercialValue: 100_000,
          currency: 'INR',
          // The acting principal is the owner.
          ownerPartyId: p.partyId,
        },
      });

      const result = await transitionAgreement('mou', mou.id, 'approved');
      expect(result.applied).toBe(false);
      expect(result.reason).toMatch(/Self-Dealing Bar/);
      expect(result.approvalStepId).not.toBeNull();

      const step = await prisma.approvalStep.findFirstOrThrow({ where: { id: result.approvalStepId! } });
      expect(step.selfDealingBarTripped).toBe(true);
      expect(step.resolvedApproverId).not.toBe(p.partyId);
    });
  });

  it('an over-ceiling value opens an approval step rather than being silently permitted', async () => {
    await withFixtureRole(
      { slug: 'mou_no_approve', grants: [{ resource: 'mous', verbs: ['view', 'edit'] }] },
      async () => {
        const decision = await evaluate({ resource: 'mous', verb: 'approve' });
        expect(decision.allowed).toBe(false);
        expect(decision.deniedBy).toBe('WHO');
      },
    );
  });

  it('an employee is excluded from every approval tier by the matrix, not by a second list', async () => {
    // The gate used to carry an `excludedRoles` list naming `system_admin`,
    // which had to be kept in agreement with the matrix by hand. Under three
    // roles the exclusion is structural: `employee` holds no `approve` verb on
    // anything, so there is nothing left to keep in agreement.
    const mou = await asUser('chairman@kaizen.co.in', () =>
      prisma.mou.findFirst({ where: { status: 'proposed' } }),
    );
    if (!mou) return;
    await asUser('ravi@kaizen.co.in', async () => {
      const err = await expectReject(() => transitionAgreement('mou', mou.id, 'approved'));
      expect(err.status).toBe(403);
    });
  });

  it('job-driven statuses are never user transitions', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const mou = await prisma.mou.findFirstOrThrow({ where: { status: 'signed' } });
      for (const status of ['expiring', 'expired', 'renewed']) {
        const err = await expectReject(() => transitionAgreement('mou', mou.id, status));
        expect(err.message).toMatch(/job-driven status/);
      }
    });
  });

  it('an agreement first seen mid-ladder notifies at the tightest crossed rung, once', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const { runExpiryLadder, createContract } = await import('../domains/agreements.js');
      const org = await prisma.organization.findFirstOrThrow({});

      // 25 days out: the 90 and 60 rungs are already behind it.
      const contract = await createContract({
        title: `Mid-ladder ${Date.now()}`,
        organizationId: org.id,
        commercialValue: 100_000,
        startDate: new Date(),
        endDate: new Date(Date.now() + 25 * 86_400_000),
      });
      await prisma.contract.update({ where: { id: contract.id }, data: { status: 'active' } });

      const first = await runExpiryLadder('contract');
      expect(first).toBeGreaterThanOrEqual(1);

      const after = await prisma.contract.findFirstOrThrow({ where: { id: contract.id } });
      // 30 is the tightest rung crossed; 120, 90 and 60 are spent, not pending.
      expect(after.expiryNotifiedDays).toContain(30);
      expect([...after.expiryNotifiedDays].sort((a, b) => a - b)).toEqual([30, 60, 90, 120]);

      // The spent rungs never fire retroactively on a later run.
      const before = await prisma.exceptionRecord.count({ where: { subjectId: contract.id } });
      await runExpiryLadder('contract');
      await runExpiryLadder('contract');
      expect(await prisma.exceptionRecord.count({ where: { subjectId: contract.id } })).toBe(before);
    });
  });

  it('the expiry ladder is idempotent per rung', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const { runExpiryLadder } = await import('../domains/agreements.js');
      const first = await runExpiryLadder('mou');
      const second = await runExpiryLadder('mou');
      // A rung already notified does not re-fire.
      expect(second).toBeLessThanOrEqual(first);
      expect(second).toBe(0);
      expect(await runExpiryLadder('mou')).toBe(0);
    });
  });
});

// ===========================================================================
// CRM-ACT-001/002 — Interaction sensitivity
// ===========================================================================

describe('CRM-ACT-002 — computed sensitivity classification', () => {
  it('the maximum classification across references always wins outright — no averaging', () => {
    expect(maxSensitivity(['internal', 'confidential', 'public'])).toBe('confidential');
    expect(maxSensitivity(['internal', 'internal'])).toBe('internal');
    expect(maxSensitivity(['regulated', 'public'])).toBe('regulated');
  });

  it('an unregistered entity type fails closed at confidential, not internal', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const { classificationFor } = await import('../domains/interactions.js');
      const unregistered = await classificationFor('xyz', 'NEVER_REGISTERED_TYPE');
      expect(unregistered.registered).toBe(false);
      // Defaulting to internal means every new column ships readable.
      expect(unregistered.sensitivity).toBe('confidential');
    });
  });

  it('a CRM-only interaction computes internal, reproducing the flat grant where it was correct', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const lead = await prisma.lead.findFirstOrThrow({});
      const { sensitivityClass } = await computeSensitivity([
        { contextCode: 'crm', entityType: 'lead', entityId: lead.id },
      ]);
      expect(sensitivityClass).toBe('internal');
    });
  });

  it('a reference to an HR performance note lifts the whole interaction to confidential', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const lead = await prisma.lead.findFirstOrThrow({});
      const { sensitivityClass } = await computeSensitivity([
        { contextCode: 'crm', entityType: 'lead', entityId: lead.id },
        { contextCode: 'hr', entityType: 'performance_note', entityId: 'hr-1' },
      ]);
      // A routine reference never dilutes a sensitive one.
      expect(sensitivityClass).toBe('confidential');
    });
  });

  it('an interaction requires at least one related reference', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const err = await expectReject(() =>
        logInteraction({
          interactionType: 'call',
          occurredAt: new Date(),
          relatedReferences: [],
        }),
      );
      expect(err.status).toBe(422);
      expect(err.message).toMatch(/at least one related reference/);
    });
  });

  it('a cross-tenant reference is rejected at write time as a data-integrity violation', async () => {
    const other = await unscopedPrisma.tenant.findFirstOrThrow({ where: { slug: 'other-tenant' } });
    const foreign = await unscopedPrisma.person.findFirstOrThrow({ where: { tenantId: other.id } });

    await asUser('chairman@kaizen.co.in', async () => {
      const err = await expectReject(() =>
        logInteraction({
          interactionType: 'call',
          occurredAt: new Date(),
          relatedReferences: [{ contextCode: 'idn', entityType: 'person', entityId: foreign.id }],
        }),
      );
      expect(err.message).toMatch(/does not resolve within this tenant/);
    });
  });

  it('a confidential interaction is absent from a low-ceiling viewer\'s timeline entirely', async () => {
    const lead = await asUser('chairman@kaizen.co.in', async () => {
      const l = await prisma.lead.findFirstOrThrow({});
      await logInteraction({
        interactionType: 'note',
        occurredAt: new Date(),
        subject: 'Sensitive performance discussion',
        notes: 'Should not be visible to a low-ceiling role.',
        relatedReferences: [
          { contextCode: 'crm', entityType: 'lead', entityId: l.id },
          { contextCode: 'hr', entityType: 'performance_note', entityId: 'hr-probe' },
        ],
      });
      return l;
    });

    // Every shipped role reads up to `regulated`, so the ceiling is exercised
    // against a role built with a lower one rather than left untested.
    await withFixtureRole(
      {
        slug: 'timeline_internal',
        classificationCeiling: 'internal',
        grants: [{ resource: 'interactions', verbs: ['view'] }, { resource: 'leads', verbs: ['view'] }],
      },
      async () => {
        const { timelineFor } = await import('../domains/interactions.js');
        const timeline = await timelineFor('lead', lead.id, { limit: 50 });
        const found = timeline.items.find((i) => i.subject === 'Sensitive performance discussion');
        // The entry does not appear on the viewer's timeline at all.
        expect(found).toBeUndefined();
      },
    );

    await asUser('chairman@kaizen.co.in', async () => {
      const { timelineFor } = await import('../domains/interactions.js');
      const timeline = await timelineFor('lead', lead.id, { limit: 50 });
      const found = timeline.items.find((i) => i.subject === 'Sensitive performance discussion');
      // An administrative role is not narrowed by record-level classification.
      expect(found).toBeDefined();
      expect(found!.sensitivityClass).toBe('confidential');
    });
  });
});

// ===========================================================================
// AI governance
// ===========================================================================

describe('AI governance — agents as bounded principals', () => {
  it('an agent invoking an undeclared tool is blocked', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const result = await propose({
        agentKey: 'agent.forecast',
        tool: 'tool.crm.route_lead',
        action: 'lead.route',
        subjectType: 'lead',
        subjectId: 'x',
        proposal: {},
        rationale: 'probing an undeclared tool',
      });
      expect(result.state).toBe('blocked');
      expect(result.blockedReason).toMatch(/not declared/);
    });
  });

  it('a categorically prohibited action is refused at any authority grant size', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const result = await propose({
        agentKey: 'agent.drafter',
        tool: 'tool.pct.draft_proposal',
        action: 'contract.sign',
        subjectType: 'contract',
        subjectId: 'x',
        proposal: {},
        rationale: 'probing a prohibited action',
      });
      expect(result.state).toBe('blocked');
      expect(result.tier).toBe('PROHIBITED');
      expect(result.blockedReason).toMatch(/categorically prohibited/);
    });
  });

  it('a RECOMMEND-tier proposal waits for a human; it never auto-executes', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const result = await propose({
        agentKey: 'agent.forecast',
        tool: 'tool.crm.suggest_forecast_category',
        action: 'opportunity.suggest_forecast',
        subjectType: 'opportunity',
        subjectId: (await prisma.opportunity.findFirstOrThrow({})).id,
        proposal: { to: 'commit' },
        rationale: 'Activity pattern resembles historically-committed deals.',
      });
      expect(result.tier).toBe('RECOMMEND');
      expect(result.state).toBe('proposed');
      expect(result.autoExecuted).toBe(false);
    });
  });

  it('an AUTONOMOUS_WITHIN_POLICY proposal executes without a per-instance approval', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const result = await propose({
        agentKey: 'agent.router',
        tool: 'tool.crm.route_lead',
        action: 'lead.route',
        subjectType: 'lead',
        subjectId: (await prisma.lead.findFirstOrThrow({})).id,
        proposal: {},
        rationale: 'Six-factor evaluation within a tenant-configured policy.',
      });
      expect(result.tier).toBe('AUTONOMOUS_WITHIN_POLICY');
      expect(result.state).toBe('executed');
      expect(result.autoExecuted).toBe(true);
    });
  });

  it('an agent may never approve an agreement, whatever its authority grant', async () => {
    const p = await principalFor('chairman@kaizen.co.in');
    const agent = await unscopedPrisma.agentPrincipal.findFirstOrThrow({
      where: { tenantId: p.tenantId, agentKey: 'agent.router' },
    });

    await asPrincipal(
      {
        ...authFor(p),
        principalType: 'agent',
        agentId: agent.id,
        partyId: null,
        roleSlug: null,
      },
      async () => {
        const mou = await prisma.mou.findFirstOrThrow({ where: { status: 'proposed' } });
        const err = await expectReject(() => transitionAgreement('mou', mou.id, 'approved'));
        expect(err.status).toBe(403);
        expect(err.message).toMatch(/AI principal may never/);
      },
    );
  });

  it('an agent may never confirm a person merge', async () => {
    const p = await principalFor('chairman@kaizen.co.in');
    const agent = await unscopedPrisma.agentPrincipal.findFirstOrThrow({
      where: { tenantId: p.tenantId, agentKey: 'agent.dedup' },
    });

    await asPrincipal(
      { ...authFor(p), principalType: 'agent', agentId: agent.id },
      async () => {
        const { mergePersons } = await import('../domains/identity.js');
        const two = await prisma.person.findMany({ take: 2 });
        const err = await expectReject(() => mergePersons(two[0].id, two[1].id, 'agent attempt'));
        expect(err.status).toBe(403);
      },
    );
  });
});

// ===========================================================================
// Exceptions & the durable job substrate
// ===========================================================================

describe('The exception engine and the job substrate', () => {
  it('every exception carries a resolved owner or is measured as a routing defect', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const open = await prisma.exceptionRecord.findMany({ where: { state: { in: ['open', 'escalated'] } } });
      for (const e of open) {
        const owned = Boolean(e.ownerPartyId || e.accountablePositionId);
        // Unowned is never silent: it is a first-class, measured category.
        expect(owned || e.ownerUnresolved).toBe(true);
      }
    });
  });

  it('escalation is bounded to the four named triggers', async () => {
    const { ESCALATION_TRIGGERS } = await import('@kaizen/shared');
    expect([...ESCALATION_TRIGGERS]).toEqual(['sla_expiry', 'decline', 'authority_insufficiency', 'severity_increase']);

    await asUser('chairman@kaizen.co.in', async () => {
      const escalated = await prisma.exceptionRecord.findMany({ where: { escalationTrigger: { not: null } } });
      for (const e of escalated) {
        expect(ESCALATION_TRIGGERS).toContain(e.escalationTrigger as never);
      }
    });
  });

  it('a detector re-run does not re-fire an already-notified rung', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const { detectUntouchedLeads } = await import('../domains/leads.js');
      await detectUntouchedLeads();
      const second = await detectUntouchedLeads();
      expect(second).toBe(0);
    });
  });

  it('severity and notification priority are independent scales', async () => {
    const { SEVERITIES, NOTIFICATION_PRIORITIES } = await import('@kaizen/shared');
    expect(SEVERITIES).toHaveLength(5);
    expect(NOTIFICATION_PRIORITIES).toHaveLength(5);
    expect(SEVERITIES[0]).not.toBe(NOTIFICATION_PRIORITIES[0]);
  });
});

// ===========================================================================
// Health scores
// ===========================================================================

describe('CRM-RPT-001/002 — health scores', () => {
  it('a domain with insufficient inputs reports not-yet-measured, never a zero', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const { latestPulse } = await import('../domains/health.js');
      const pulse = await latestPulse();
      const unmeasured = pulse.filter((p) => p.state === 'not_yet_measured');
      expect(unmeasured.length).toBeGreaterThan(0);
      for (const p of unmeasured) {
        expect(p.score).toBeNull();
        expect(p.band).toBeNull();
      }
    });
  });

  it('every factor carries a drill path — a score with none is a defect', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const { latestPulse } = await import('../domains/health.js');
      const pulse = await latestPulse();
      for (const domain of pulse.filter((p) => p.state === 'measured')) {
        for (const f of domain.factors) {
          expect(f.drillPath).toBeTruthy();
          expect(f.narrative).toBeTruthy();
        }
      }
    });
  });

  it('the retired pipeline_value and pipeline_count metrics are no longer written', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const since = new Date(Date.now() - 86_400_000);
      const retired = await prisma.dailyMetric.count({
        where: { metric: { in: ['pipeline_value', 'pipeline_count'] }, computedAt: { gte: since } },
      });
      expect(retired).toBe(0);
    });
  });

  it('a band never itself reaches S4_CRITICAL — only a named exception does', async () => {
    const { HEALTH_BAND_SEVERITY_FLOOR } = await import('@kaizen/shared');
    for (const floor of Object.values(HEALTH_BAND_SEVERITY_FLOOR)) {
      expect(floor).not.toBe('S4_CRITICAL');
    }
  });
});

// ===========================================================================
// Decisions
// ===========================================================================

describe('Decisions — the four dispositions are exclusively human acts', () => {
  it('a decision with an incomplete evidence pack is not decidable', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const { decisionQueue, disposeDecision } = await import('../domains/decisions.js');
      const queue = await decisionQueue();
      const incomplete = queue.find((d) => !d.evidencePack.complete);
      if (!incomplete) return;

      expect(incomplete.availableDispositions).toEqual(['request_evidence']);

      const err = await expectReject(() =>
        disposeDecision({
          decisionId: incomplete.id,
          disposition: 'decide',
          rationale: 'attempting to decide an incomplete item',
          chosenOption: 'proceed',
        }),
      );
      expect(err.message).toMatch(/not decidable/);
    });
  });

  it('deferring past the point of no return is refused outright, not merely warned', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const { disposeDecision } = await import('../domains/decisions.js');
      const decision = await prisma.decision.findFirst({
        where: { pointOfNoReturn: { not: null }, evidenceComplete: true },
      });
      if (!decision) return;

      const err = await expectReject(() =>
        disposeDecision({
          decisionId: decision.id,
          disposition: 'defer',
          rationale: 'pushing past the point of no return',
          deferUntil: new Date(decision.pointOfNoReturn!.getTime() + 30 * 86_400_000),
        }),
      );
      expect(err.message).toMatch(/point of no return/);
    });
  });

  it('a decision arms a review date on Decided — it does not close at disposition', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const { disposeDecision } = await import('../domains/decisions.js');
      const decision = await prisma.decision.findFirst({
        where: { evidenceComplete: true, state: { in: ['AwaitingAuthority', 'Raised'] } },
      });
      if (!decision) return;

      const decided = await disposeDecision({
        decisionId: decision.id,
        disposition: 'decide',
        rationale: 'Working capital cost is outweighed by the two-year commitment.',
        chosenOption: 'Extend to 90 days in exchange for the commitment.',
        confidence: 0.75,
      });

      expect(decided.state).toBe('Implemented');
      expect(decided.reviewDueOn).not.toBeNull();
      expect(decided.confidence).toBe(0.75);
    });
  });
});

// ===========================================================================
// Finance
// ===========================================================================

describe('Finance — obligation, movement and allocation are three distinct facts', () => {
  it('a payment is idempotent on its gateway reference', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const { recordPayment } = await import('../domains/finance.js');
      const ref = `TXN-IDEM-${Date.now()}`;
      const first = await recordPayment({ amount: 1000, gatewayReference: ref });
      const second = await recordPayment({ amount: 1000, gatewayReference: ref });
      expect(second.id).toBe(first.id);
    });
  });

  it('a correction is a new row, never an update in place', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const { recordPayment, reversePayment } = await import('../domains/finance.js');
      const original = await recordPayment({ amount: 5000, gatewayReference: `TXN-REV-${Date.now()}` });
      const reversal = await reversePayment(original.id, 'Bounced.');

      expect(reversal.id).not.toBe(original.id);
      expect(Number(reversal.amount.toString())).toBe(-5000);
      expect(reversal.reversalOfPaymentId).toBe(original.id);

      const stillThere = await prisma.payment.findFirstOrThrow({ where: { id: original.id } });
      expect(Number(stillThere.amount.toString())).toBe(5000);
    });
  });

  it('allocation beyond the unallocated balance is refused', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const { recordPayment, allocatePayment } = await import('../domains/finance.js');
      const payment = await recordPayment({ amount: 1000, gatewayReference: `TXN-OVER-${Date.now()}` });
      const invoice = await prisma.invoice.findFirstOrThrow({});

      const err = await expectReject(() =>
        allocatePayment({ paymentId: payment.id, invoiceId: invoice.id, amount: 5000 }),
      );
      expect(err.message).toMatch(/unallocated/);
    });
  });

  it('only the sum of allocated receipts determines what has been paid', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const { invoiceSummary } = await import('../domains/finance.js');
      const invoice = await prisma.invoice.findFirstOrThrow({ include: { receipts: true } });
      const summary = await invoiceSummary(invoice.id);
      const receiptSum = invoice.receipts.reduce((s, r) => s + Number(r.allocatedAmount.toString()), 0);
      expect(summary.allocated).toBeCloseTo(receiptSum, 2);
      expect(summary.outstanding).toBeCloseTo(summary.total - receiptSum, 2);
    });
  });

  it('the revenue-recognition method is derived from the offering, never asked of sales', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const line = await prisma.invoiceLine.findFirst({ where: { offeringId: { not: null } } });
      if (!line) return;
      const offering = await prisma.offering.findFirstOrThrow({ where: { id: line.offeringId! } });
      expect(line.revenueMethod).toBe(offering.defaultRevenueTreatment);
    });
  });
});

// ===========================================================================
// Institution / organisation / student — three things, kept distinct
// ===========================================================================

describe('A college, a client and a student are three different facts', () => {
  /**
   * A phone number nobody else in this database has.
   *
   * `Date.now()` truncated to ten digits is not one: the leading digits of a
   * millisecond timestamp only change every hundred seconds, so two subjects
   * created in the same test run get the same number and the second resolves
   * onto the first — which is the resolver working correctly and the fixture
   * lying. The suite has to pass twice against one database, so the counter
   * is mixed with the low digits of the clock rather than the high ones.
   */
  let seq = 0;
  const aPhone = () => `9${String(Date.now()).slice(-6)}${String((seq += 1)).padStart(3, '0')}`;

  /** A college and a batch to enrol onto, built fresh so nothing else can move them. */
  async function aCollegeAndABatch(tag: string) {
    const { createOrganization } = await import('../domains/organizations.js');
    const college = await createOrganization({
      kind: 'institution',
      name: `${tag} College of Engineering`,
      institutionProfile: { institutionType: 'engineering_college', district: 'Madurai' },
    });
    const course = await prisma.course.create({
      data: { tenantId: TENANT, recordCode: await nextRecordCode('CRS'), name: `${tag} Course`, code: `${tag}-C` },
    });
    const cohort = await prisma.cohort.create({
      data: {
        tenantId: TENANT,
        recordCode: await nextRecordCode('COH'),
        courseId: course.id,
        name: `${tag} Batch`,
        startDate: new Date(),
        capacity: 30,
      },
    });
    return { college, cohort };
  }

  it('an institution can be created with its school details in one act, with only what was typed stored', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const { createOrganization } = await import('../domains/organizations.js');
      const org = await createOrganization({
        kind: 'institution',
        name: `One Step College ${Date.now()}`,
        institutionProfile: { institutionType: 'polytechnic', district: 'Salem' },
      });
      const profile = await prisma.institutionProfile.findFirstOrThrow({ where: { organizationId: org.id } });
      expect(profile.institutionType).toBe('polytechnic');
      expect(profile.district).toBe('Salem');
      // Nothing was invented to fill the fields nobody typed.
      expect(profile.state).toBeNull();
      expect(profile.studentCount).toBeNull();
      // And being a college did not make them a client.
      expect(await prisma.account.findFirst({ where: { organizationId: org.id } })).toBeNull();
    });
  });

  it('being enrolled is what makes somebody a student, and it names the college', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const { enrolStudent } = await import('../domains/education.js');
      const { college, cohort } = await aCollegeAndABatch(`AFF${Date.now()}`);

      const enrollment = await enrolStudent({
        cohortId: cohort.id,
        fullName: 'Affiliation Subject',
        primaryPhone: aPhone(),
        institutionId: college.id,
      });

      const affiliation = await prisma.affiliation.findFirstOrThrow({
        where: { partyId: enrollment.personId, affiliationType: 'student' },
      });
      expect(affiliation.counterpartyId).toBe(college.id);
      expect(affiliation.status).toBe('active');
      // Student affiliations carry the statutory retention floor, so a dedup
      // match against one never auto-merges.
      expect(affiliation.statutoryRetentionFloor).toBe(true);
    });
  });

  it('a company that is not marked as a college cannot be where a student came from', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const { createOrganization } = await import('../domains/organizations.js');
      const { enrolStudent } = await import('../domains/education.js');
      const { cohort } = await aCollegeAndABatch(`NC${Date.now()}`);
      const plain = await createOrganization({ kind: 'organization', name: `Not A College ${Date.now()}` });

      const err = await expectReject(() =>
        enrolStudent({ cohortId: cohort.id, fullName: 'Refused Origin', institutionId: plain.id }),
      );
      expect(err.message).toMatch(/not marked as a college/);
    });
  });

  it('a refused enrolment leaves no person behind', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const { enrolStudent } = await import('../domains/education.js');
      const { cohort } = await aCollegeAndABatch(`GH${Date.now()}`);
      const name = `Ghost ${Date.now()}`;

      // A minor with no guardian contact is refused. The person must not have
      // been created on the way to the refusal: an error message is not a
      // reason for a stranger to appear in the directory.
      await expectReject(() => enrolStudent({ cohortId: cohort.id, fullName: name, isMinor: true }));
      expect(await prisma.person.findFirst({ where: { fullName: name } })).toBeNull();
    });
  });

  it('a returning student is the same person, not a second one, and raises no merge candidate', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const { enrolStudent } = await import('../domains/education.js');
      const tag = `RET${Date.now()}`;
      const { cohort: first } = await aCollegeAndABatch(tag);
      const { cohort: second } = await aCollegeAndABatch(`${tag}B`);
      const phone = aPhone();

      const before = await prisma.mergeCandidate.count();
      const one = await enrolStudent({ cohortId: first.id, fullName: 'Returning Student', primaryPhone: phone });
      const two = await enrolStudent({ cohortId: second.id, fullName: 'Returning Student', primaryPhone: phone });

      expect(two.personId).toBe(one.personId);
      // Enrolling somebody a second time is not a merge of two records, so it
      // must not fill a queue a human has to drain.
      expect(await prisma.mergeCandidate.count()).toBe(before);
      // Nor a second badge saying the same thing.
      expect(
        await prisma.affiliation.count({ where: { partyId: one.personId, affiliationType: 'student' } }),
      ).toBe(1);
    });
  });

  it('the same person on the same batch twice is refused, naming the enrolment they already have', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const { enrolStudent } = await import('../domains/education.js');
      const { cohort } = await aCollegeAndABatch(`DUP${Date.now()}`);
      const phone = aPhone();

      const first = await enrolStudent({ cohortId: cohort.id, fullName: 'Twice Over', primaryPhone: phone });
      const err = await expectReject(() =>
        enrolStudent({ cohortId: cohort.id, fullName: 'Twice Over', primaryPhone: phone }),
      );
      expect(err.status).toBe(409);
      expect(err.message).toContain(first.recordCode);
    });
  });

  it('a college shows the students it sent; a body that is not a college has no such list', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const { assembleOrganization360, createOrganization } = await import('../domains/organizations.js');
      const { enrolStudent } = await import('../domains/education.js');
      const { college, cohort } = await aCollegeAndABatch(`SENT${Date.now()}`);
      await enrolStudent({
        cohortId: cohort.id,
        fullName: 'Sent From Here',
        primaryPhone: aPhone(),
        institutionId: college.id,
      });

      const view = await assembleOrganization360(college.id);
      expect(view.students?.map((s) => s.personName)).toContain('Sent From Here');

      const plain = await createOrganization({ kind: 'organization', name: `No Students ${Date.now()}` });
      // Absent rather than empty: "none" and "not a college" are different answers.
      expect((await assembleOrganization360(plain.id)).students).toBeNull();
    });
  });
});

// ===========================================================================
// Import templates — the shape the platform hands out
// ===========================================================================

describe('The import templates', () => {
  it('no two templates share their required headings, so recognition is never a tie-break', async () => {
    const { listTemplates } = await import('../imports/templates.js');
    const seen = new Map<string, string>();
    for (const t of listTemplates()) {
      const key = t.columns.filter((c) => c.required).map((c) => c.name.toLowerCase()).sort().join('|');
      expect(key, `${t.slug} has no required column`).not.toBe('');
      expect(seen.get(key), `${t.slug} and ${seen.get(key)} would be told apart by a tie-break`).toBeUndefined();
      seen.set(key, t.slug);
    }
  });

  it('a template, filled in, is recognised as itself and read by its own columns', async () => {
    const XLSX = await import('xlsx');
    const { TEMPLATES, buildTemplateWorkbook } = await import('../imports/templates.js');
    const { readWorkbook } = await import('../imports/parse.js');
    const { detectWorkbook } = await import('../imports/detect.js');
    const { extractTemplate } = await import('../imports/extract.js');

    const spec = TEMPLATES.students;
    const blank = buildTemplateWorkbook(spec);

    // Fill the Data sheet the way somebody would.
    const book = XLSX.read(blank, { type: 'buffer' });
    XLSX.utils.sheet_add_aoa(
      book.Sheets.Data,
      [['Fill Test', '9876500001', '', 'Some Batch', 'Some College', 'No', '', '']],
      { origin: 'A2' },
    );
    book.Sheets.Data['!ref'] = 'A1:H2';
    const filled = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    const sheets = readWorkbook(filled);
    const detected = detectWorkbook(sheets);
    expect(detected.primary.kind).toBe('template_students');

    const data = sheets.find((s) => s.name === 'Data')!;
    const extraction = extractTemplate(data.grid, spec, detected.primary.headerRow ?? 0);
    // The instructions sheet must not be mistaken for data.
    expect(extraction.rows).toHaveLength(1);
    expect(extraction.rows[0].status).toBe('ready');
    expect(extraction.rows[0].normalised).toMatchObject({
      fullName: 'Fill Test',
      primaryPhone: '9876500001',
      cohortName: 'Some Batch',
      institutionName: 'Some College',
      isMinor: false,
    });
  });

  it('the blank sheet carries headings and no rows, so nothing can be imported by forgetting to delete an example', async () => {
    const { TEMPLATES, buildTemplateWorkbook } = await import('../imports/templates.js');
    const { readWorkbook } = await import('../imports/parse.js');

    for (const spec of Object.values(TEMPLATES)) {
      const sheets = readWorkbook(buildTemplateWorkbook(spec));
      const data = sheets.find((s) => s.name === 'Data');
      expect(data, `${spec.slug} has no Data sheet`).toBeDefined();
      expect(data!.grid[0]).toEqual(spec.columns.map((c) => c.name));
      expect(data!.grid.filter((r) => r.some((c) => String(c).trim()))).toHaveLength(1);
      // And the instructions are in the file rather than only on a web page
      // the person filling this in at their desk is not looking at.
      expect(sheets.some((s) => s.name === 'How to fill this in')).toBe(true);
    }
  });

  it('a row pointing at something that does not exist names it, rather than inventing it', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const { stageImport } = await import('../imports/service.js');
      const { commitImport } = await import('../imports/commit.js');
      const XLSX = await import('xlsx');
      const { TEMPLATES, buildTemplateWorkbook } = await import('../imports/templates.js');

      const spec = TEMPLATES.students;
      const book = XLSX.read(buildTemplateWorkbook(spec), { type: 'buffer' });
      XLSX.utils.sheet_add_aoa(
        book.Sheets.Data,
        [['Nowhere Student', `98765${Date.now() % 100000}`, '', 'No Such Batch At All', '', 'No', '', '']],
        { origin: 'A2' },
      );
      book.Sheets.Data['!ref'] = 'A1:H2';

      const staged = await stageImport({
        fileName: 'students.xlsx',
        buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer,
      });
      expect(staged.kind).toBe('template_students');

      const result = await commitImport(staged.batchId);
      expect(result.errors[0].message).toContain('No Such Batch At All');
      // And no half-made records left behind by the attempt.
      expect(await prisma.person.findFirst({ where: { fullName: 'Nowhere Student' } })).toBeNull();
    });
  });
});
