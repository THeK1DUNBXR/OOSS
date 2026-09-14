/**
 * HCM — WS11 assets (docs/hcm/assets.md).
 *
 * HCM-ASSETS-001..012: asset inventory and assignment lifecycle, money
 * masking on cost fields, travel request approval under the Self-Dealing
 * Bar, letter-request fulfilment through both the HrLetter path and this
 * workstream's own snapshot path, ID card issuance and loss, and cross-tenant
 * isolation.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { asSystem, type AuthContext } from '../../platform/context.js';
import { asPrincipal, asUser, expectReject, prisma, tenantId, unscopedPrisma, withFixtureRole } from '../helpers.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { hire, transitionEmployment } from '../../domains/employment.js';
import {
  listAssets, createAsset, transitionAsset,
  listAssetAssignments, assignAsset, returnAsset,
  listTravelRequests, createTravelRequest, decideTravelRequest, settleTravelRequest,
  listLetterRequests, createLetterRequest, fulfilLetterRequest, rejectLetterRequest, listIssuedHrLetters,
  listIdCards, issueIdCard, reportIdCardLost,
  assetsPendingForEmployment,
} from '../../domains/hcm/assets.js';

let TENANT: string;
let fixtureSeq = 0;

beforeAll(async () => {
  TENANT = await tenantId();
});

/** A throwaway employee with no login — its person id is used directly via `asEmployee`. */
async function makeEmployee(label: string) {
  fixtureSeq += 1;
  const stamp = `${Date.now()}-${fixtureSeq}`;
  return asUser('operations@kaizen.co.in', async () => {
    const position = await prisma.position.create({
      data: {
        tenantId: TENANT,
        recordCode: await nextRecordCode('POS'),
        jobId: (await prisma.job.findFirstOrThrow({ where: { tenantId: TENANT } })).id,
        orgUnitId: (await prisma.orgUnit.findFirstOrThrow({ where: { tenantId: TENANT } })).id,
        status: 'Open',
      },
    });
    const person = await prisma.person.create({
      data: {
        tenantId: TENANT,
        recordCode: await nextRecordCode('PER'),
        fullName: `Fixture ${label} ${stamp}`,
        primaryEmail: `fixture.assets.${label}.${stamp}@example.com`,
        source: 'test',
      },
    });
    const employment = await hire({ personId: person.id, positionId: position.id, hireEffectiveDate: new Date() });
    await transitionEmployment(employment.id, 'ACTIVATE');
    return { employment, person };
  });
}

/** Runs `fn` as a bare employee principal for `partyId`. */
async function asEmployee<T>(partyId: string, fn: () => Promise<T>): Promise<T> {
  const auth: AuthContext = {
    tenantId: TENANT,
    principalType: 'human',
    partyId,
    userId: null,
    agentId: null,
    onBehalfOfPartyId: null,
    affiliationId: null,
    roleSlug: 'employee',
    branch: null,
    orgUnitId: null,
    classificationCeiling: 'regulated',
    purpose: 'operational',
    consentCodes: [],
    stepUpVerified: true,
  };
  return asPrincipal(auth, fn);
}

let tagSeq = 0;
async function makeAsset(cost = 45000) {
  tagSeq += 1;
  return asUser('operations@kaizen.co.in', () =>
    createAsset({ tag: `LAPTOP-${Date.now()}-${tagSeq}`, category: 'laptop', cost }),
  );
}

// ===========================================================================
// Inventory
// ===========================================================================

describe('Asset inventory (HCM-ASSETS-001, 002)', () => {
  it('HCM-ASSETS-001: an asset\'s cost is masked for a viewer with no financial verb, and visible to the chairman', async () => {
    const created = await makeAsset(52000);
    expect(created.cost).toBeNull(); // hr_ops_manager holds no `financial` verb on hcm_assets

    const asOps = await asUser('operations@kaizen.co.in', () => listAssets({}));
    const opsRow = asOps.find((a) => a.id === created.id)!;
    expect(opsRow.cost).toBeNull();

    const asChairman = await asUser('chairman@kaizen.co.in', () => listAssets({}));
    const chairmanRow = asChairman.find((a) => a.id === created.id)!;
    expect(Number(chairmanRow.cost)).toBe(52000);
  });

  it('HCM-ASSETS-002: an asset not in stock cannot be assigned again', async () => {
    const asset = await makeAsset();
    const { employment } = await makeEmployee('double-assign');
    await asUser('operations@kaizen.co.in', () => assignAsset({ assetId: asset.id, employmentRelationshipId: employment.id }));

    const { employment: other } = await makeEmployee('double-assign-2');
    const err = await expectReject(() =>
      asUser('operations@kaizen.co.in', () => assignAsset({ assetId: asset.id, employmentRelationshipId: other.id })),
    );
    expect(err.status).toBe(422);
  });
});

describe('Asset assignment and return (HCM-ASSETS-003, 004)', () => {
  it('HCM-ASSETS-003: returning an asset in poor condition sends it to repair; good condition returns it to stock', async () => {
    const assetGood = await makeAsset();
    const assetPoor = await makeAsset();
    const { employment: e1 } = await makeEmployee('return-good');
    const { employment: e2 } = await makeEmployee('return-poor');

    const a1 = await asUser('operations@kaizen.co.in', () => assignAsset({ assetId: assetGood.id, employmentRelationshipId: e1.id }));
    const a2 = await asUser('operations@kaizen.co.in', () => assignAsset({ assetId: assetPoor.id, employmentRelationshipId: e2.id }));

    await asUser('operations@kaizen.co.in', () => returnAsset(a1.id, { condition: 'good' }));
    await asUser('operations@kaizen.co.in', () => returnAsset(a2.id, { condition: 'poor' }));

    const after1 = await asUser('operations@kaizen.co.in', () => prisma.asset.findUniqueOrThrow({ where: { id: assetGood.id } }));
    const after2 = await asUser('operations@kaizen.co.in', () => prisma.asset.findUniqueOrThrow({ where: { id: assetPoor.id } }));
    expect(after1.status).toBe('in_stock');
    expect(after2.status).toBe('repair');
  });

  it('HCM-ASSETS-004: a retired asset cannot be moved back to stock', async () => {
    const asset = await makeAsset();
    await asUser('operations@kaizen.co.in', () => transitionAsset(asset.id, 'retired'));
    const err = await expectReject(() => asUser('operations@kaizen.co.in', () => transitionAsset(asset.id, 'in_stock' as never)));
    expect(err.status).toBe(422);
  });

  it('HCM-ASSETS-005: an employee sees only their own assignments (self scope)', async () => {
    const asset = await makeAsset();
    const { employment, person } = await makeEmployee('own-scope');
    await asUser('operations@kaizen.co.in', () => assignAsset({ assetId: asset.id, employmentRelationshipId: employment.id }));

    const mine = await asEmployee(person.id, () => listAssetAssignments({}));
    expect(mine.some((a) => a.employmentRelationshipId === employment.id)).toBe(true);

    const { employment: colleague } = await makeEmployee('own-scope-colleague');
    const anotherAsset = await makeAsset();
    await asUser('operations@kaizen.co.in', () => assignAsset({ assetId: anotherAsset.id, employmentRelationshipId: colleague.id }));
    const mineAgain = await asEmployee(person.id, () => listAssetAssignments({}));
    expect(mineAgain.some((a) => a.employmentRelationshipId === colleague.id)).toBe(false);
  });
});

// ===========================================================================
// Travel requests
// ===========================================================================

describe('Travel requests (HCM-ASSETS-006, 007, 008)', () => {
  it('HCM-ASSETS-006: an employee may submit their own travel request', async () => {
    const { employment, person } = await makeEmployee('travel-submit');
    const request = await asEmployee(person.id, () =>
      createTravelRequest({
        employmentRelationshipId: employment.id,
        purpose: 'Client visit',
        fromLocation: 'Chennai',
        toLocation: 'Bengaluru',
        startDate: new Date(Date.now() + 7 * 86_400_000),
        endDate: new Date(Date.now() + 9 * 86_400_000),
        mode: 'flight',
        estimatedCost: 12000,
      }),
    );
    expect(request.status).toBe('submitted');
    expect(request.recordCode).toMatch(/^TRV-/);
  });

  it('HCM-ASSETS-007: the Self-Dealing Bar refuses a traveller deciding their own request, even holding the approve grant', async () => {
    // An ordinary employee never holds `travel_requests:approve`, so a
    // self-decide attempt from one would be refused on the WHO axis before
    // ever reaching the Self-Dealing Bar. To exercise the bar itself, the
    // fixture principal below actually holds `approve` — and is still barred
    // because it is also the traveller.
    await withFixtureRole(
      { slug: 'travel-approver-self', grants: [{ resource: 'travel_requests', verbs: ['view', 'create', 'approve'] }] },
      async (p) => {
        const jobId = (await prisma.job.findFirstOrThrow({ where: { tenantId: TENANT } })).id;
        const orgUnitId = (await prisma.orgUnit.findFirstOrThrow({ where: { tenantId: TENANT } })).id;
        const employment = await asUser('operations@kaizen.co.in', async () => {
          const position = await prisma.position.create({
            data: { tenantId: TENANT, recordCode: await nextRecordCode('POS'), jobId, orgUnitId, status: 'Open' },
          });
          const e = await hire({ personId: p.partyId, positionId: position.id, hireEffectiveDate: new Date() });
          await transitionEmployment(e.id, 'ACTIVATE');
          return e;
        });

        const request = await createTravelRequest({
          employmentRelationshipId: employment.id,
          purpose: 'Conference',
          fromLocation: 'Chennai',
          toLocation: 'Delhi',
          startDate: new Date(Date.now() + 14 * 86_400_000),
          endDate: new Date(Date.now() + 16 * 86_400_000),
          mode: 'flight',
          estimatedCost: 25000,
        });

        const err = await expectReject(() => decideTravelRequest(request.id, 'approved'));
        expect(err.status).toBe(403);
        expect(err.message).toMatch(/Self-Dealing Bar/);
      },
    );
  });

  it('HCM-ASSETS-008: a different approver may approve, then the request settles against an ExpenseClaim id', async () => {
    const { employment, person } = await makeEmployee('travel-approve');
    const request = await asEmployee(person.id, () =>
      createTravelRequest({
        employmentRelationshipId: employment.id,
        purpose: 'Site inspection',
        fromLocation: 'Chennai',
        toLocation: 'Coimbatore',
        startDate: new Date(Date.now() + 21 * 86_400_000),
        endDate: new Date(Date.now() + 22 * 86_400_000),
        mode: 'road',
        estimatedCost: 4000,
      }),
    );
    const approved = await asUser('operations@kaizen.co.in', () => decideTravelRequest(request.id, 'approved', 'Fine to travel'));
    expect(approved.status).toBe('approved');

    const settled = await asUser('operations@kaizen.co.in', () => settleTravelRequest(request.id, 'expense-claim-fixture-id'));
    expect(settled.status).toBe('settled');
    expect(settled.expenseClaimId).toBe('expense-claim-fixture-id');

    const err = await expectReject(() => asUser('operations@kaizen.co.in', () => settleTravelRequest(request.id, 'again')));
    expect(err.status).toBe(422);
  });

  it('a rejected travel request cannot later be approved', async () => {
    const { employment, person } = await makeEmployee('travel-reject');
    const request = await asEmployee(person.id, () =>
      createTravelRequest({
        employmentRelationshipId: employment.id,
        purpose: 'Vendor meeting',
        fromLocation: 'Chennai',
        toLocation: 'Madurai',
        startDate: new Date(Date.now() + 3 * 86_400_000),
        endDate: new Date(Date.now() + 4 * 86_400_000),
        mode: 'train',
        estimatedCost: 2000,
      }),
    );
    await asUser('operations@kaizen.co.in', () => decideTravelRequest(request.id, 'rejected', 'Not this quarter'));
    const err = await expectReject(() => asUser('operations@kaizen.co.in', () => decideTravelRequest(request.id, 'approved')));
    expect(err.status).toBe(422);
  });
});

// ===========================================================================
// Letter requests
// ===========================================================================

describe('Letter requests (HCM-ASSETS-009, 010, 011)', () => {
  it('HCM-ASSETS-009: fulfilling an "experience" request issues a real HrLetter', async () => {
    const { employment, person } = await makeEmployee('letter-experience');
    const request = await asEmployee(person.id, () => createLetterRequest({ employmentRelationshipId: employment.id, kind: 'experience' }));
    const fulfilled = await asUser('operations@kaizen.co.in', () => fulfilLetterRequest(request.id));
    expect(fulfilled.status).toBe('fulfilled');
    expect(fulfilled.hrLetterId).not.toBeNull();

    const letter = await asUser('operations@kaizen.co.in', () => prisma.hrLetter.findUniqueOrThrow({ where: { id: fulfilled.hrLetterId! } }));
    expect(letter.kind).toBe('experience');
    expect(letter.employmentRelationshipId).toBe(employment.id);
  });

  it('HCM-ASSETS-010: fulfilling a "noc" request writes this workstream\'s own snapshot, not an HrLetter', async () => {
    const { employment, person } = await makeEmployee('letter-noc');
    const request = await asEmployee(person.id, () => createLetterRequest({ employmentRelationshipId: employment.id, kind: 'noc' }));
    const fulfilled = await asUser('operations@kaizen.co.in', () => fulfilLetterRequest(request.id));
    expect(fulfilled.status).toBe('fulfilled');
    expect(fulfilled.hrLetterId).toBeNull();
    expect(fulfilled.number).toMatch(/^LREQ-/);
    const snapshot = fulfilled.snapshot as { body: string } | null;
    expect(snapshot?.body).toMatch(/No-Objection Certificate/);
  });

  it('HCM-ASSETS-011: a fulfilled letter request cannot be fulfilled again, and a rejected one cannot be fulfilled', async () => {
    const { employment, person } = await makeEmployee('letter-double');
    const request = await asEmployee(person.id, () => createLetterRequest({ employmentRelationshipId: employment.id, kind: 'visa' }));
    await asUser('operations@kaizen.co.in', () => fulfilLetterRequest(request.id));
    const err = await expectReject(() => asUser('operations@kaizen.co.in', () => fulfilLetterRequest(request.id)));
    expect(err.status).toBe(422);

    const { employment: e2, person: p2 } = await makeEmployee('letter-rejected');
    const request2 = await asEmployee(p2.id, () => createLetterRequest({ employmentRelationshipId: e2.id, kind: 'address_proof' }));
    await asUser('operations@kaizen.co.in', () => rejectLetterRequest(request2.id, 'Not eligible yet'));
    const err2 = await expectReject(() => asUser('operations@kaizen.co.in', () => fulfilLetterRequest(request2.id)));
    expect(err2.status).toBe(422);
  });

  it('an employee cannot see a colleague\'s letter requests', async () => {
    const { employment, person } = await makeEmployee('letter-scope-a');
    const { person: other } = await makeEmployee('letter-scope-b');
    await asEmployee(person.id, () => createLetterRequest({ employmentRelationshipId: employment.id, kind: 'salary_certificate' }));

    const mine = await asEmployee(person.id, () => listLetterRequests({}));
    expect(mine.length).toBeGreaterThan(0);
    const others = await asEmployee(other.id, () => listLetterRequests({}));
    expect(others.every((r) => r.employmentRelationshipId !== employment.id)).toBe(true);
  });

  it('WS5 scope-axis review: an employee cannot read a colleague\'s issued HrLetters by passing their employment id', async () => {
    const { employment, person } = await makeEmployee('letter-hrletter-scope-a');
    const { person: other } = await makeEmployee('letter-hrletter-scope-b');
    const request = await asEmployee(person.id, () => createLetterRequest({ employmentRelationshipId: employment.id, kind: 'experience' }));
    await asUser('operations@kaizen.co.in', () => fulfilLetterRequest(request.id));

    // The subject may read their own.
    const mine = await asEmployee(person.id, () => listIssuedHrLetters(employment.id));
    expect(mine.length).toBeGreaterThan(0);

    // A colleague passing the same employment id — the exact shape of the
    // `assertCan`-without-a-record bug the WS5 review flagged — is refused.
    const err = await expectReject(() => asEmployee(other.id, () => listIssuedHrLetters(employment.id)));
    expect(err.status).toBe(404);
  });
});

// ===========================================================================
// ID cards
// ===========================================================================

describe('ID cards (HCM-ASSETS-012)', () => {
  it('HCM-ASSETS-012: reporting a card lost marks it lost and issues a distinct reissued card', async () => {
    const { employment } = await makeEmployee('idcard');
    const card = await asUser('operations@kaizen.co.in', () => issueIdCard(employment.id));
    const { lost, reissued } = await asUser('operations@kaizen.co.in', () => reportIdCardLost(card.id));
    expect(lost.status).toBe('lost');
    expect(reissued.status).toBe('reissued');
    expect(reissued.cardNumber).not.toBe(card.cardNumber);

    const cards = await asUser('operations@kaizen.co.in', () => listIdCards({ employmentRelationshipId: employment.id }));
    expect(cards.length).toBe(2);
  });
});

// ===========================================================================
// Cross-tenant isolation
// ===========================================================================

describe('Cross-tenant isolation (HCM-ASSETS-013)', () => {
  it('HCM-ASSETS-013: an asset is invisible from another tenant (404, not a leak)', async () => {
    const asset = await makeAsset();

    const otherTenant = await unscopedPrisma.tenant.create({
      data: { name: `Other Tenant ${Date.now()}`, slug: `other-assets-${Date.now()}` },
    });
    // A brand-new tenant has no seeded AccessRole/Grant rows, so a `human`
    // principal there would fail on the WHO axis before ever reaching the
    // tenant scope check — that would test the grant seed, not tenant
    // isolation. `system` bypasses the grant lookup by design (always
    // `allowed`), which is what actually exercises the tenant filter: the
    // asset genuinely exists, just not in this tenant's rows.
    const err = await expectReject(() => asSystem(otherTenant.id, () => transitionAsset(asset.id, 'retired')));
    expect(err.status).toBe(404);
  });
});

// ===========================================================================
// WS5 scope-axis review — assetsPendingForEmployment had no check at all
// ===========================================================================

describe('WS5 scope-axis review: assetsPendingForEmployment', () => {
  it('an employee may ask about their own pending returns, but not a colleague\'s', async () => {
    const asset = await makeAsset();
    const { employment, person } = await makeEmployee('pending-scope-a');
    const { person: other } = await makeEmployee('pending-scope-b');
    await asUser('operations@kaizen.co.in', () => assignAsset({ assetId: asset.id, employmentRelationshipId: employment.id }));

    const mine = await asEmployee(person.id, () => assetsPendingForEmployment(employment.id));
    expect(mine).toBe(1);

    const err = await expectReject(() => asEmployee(other.id, () => assetsPendingForEmployment(employment.id)));
    expect(err.status).toBe(404);
  });
});
