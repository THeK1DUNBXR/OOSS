/**
 * PR12: the HR mapping case (P11-DESIGN section e test 4; O9 A).
 *
 * When HR answers an access mapping, the suggestion carries an HR case of category
 * `access_mapping`, confidential, raised by HR. HR cannot confirm its own mapping; the
 * founder confirms. Real Postgres and real contexts, no mocks.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { unscopedPrisma } from '../platform/db.js';
import { addMissingGrants } from '../platform/grantSync.js';
import { confirmAssignment, suggestAssignment } from '../domains/access/assignments.js';
import { asPrincipal, asUser, expectReject, principalFor, tenantId } from './helpers.js';
import {
  authOf,
  grantIndividual,
  makeConfirmedPlacement,
  makeFounderPlacement,
  makeLevel,
  makePerson,
  makeVertical,
} from './access/factories.js';

const CHAIRMAN = 'chairman@kaizen.co.in';

let tid: string;
let hrId: string;
let staffVertical: string;
let staffLevel: string;

/** The HR role. Its auth carries the role slug, so the suggestion is recognised as HR's. */
const hrAuth = () => ({ ...authOf(tid, hrId), roleSlug: 'hr_ops_manager' });
const asHr = <T>(fn: () => Promise<T>) => asPrincipal(hrAuth(), fn);
const asFounder = <T>(fn: () => Promise<T>) => asUser(CHAIRMAN, async () => fn());
const plc = (verticalCode: string, levelCode: string) => ({ verticalCode, levelCode, unitCode: null });

beforeAll(async () => {
  tid = await tenantId();
  await addMissingGrants(tid);
  const founderId = (await principalFor(CHAIRMAN)).partyId;
  await makeFounderPlacement(tid, founderId);

  const sv = await makeVertical(tid, 'shared');
  const staff = await makeLevel(tid, 'own');
  const head = await makeLevel(tid, 'vertical');
  staffVertical = sv.code;
  staffLevel = staff.code;

  const hr = await makePerson(tid, 'HR owner');
  hrId = hr.id;
  await grantIndividual(tid, hrId, 'access_assignments', ['view', 'create', 'edit', 'approve'], 'all');
  await makeConfirmedPlacement(tid, hrId, sv.id, head.id);
});

describe('PR12 HR mapping case (design test 4)', () => {
  it('HR cannot confirm its own mapping (403); the founder confirms; the HR case is access_mapping and confidential', async () => {
    const subject = await makePerson(tid, 'New hire');
    const row = await asHr(() =>
      suggestAssignment({
        personId: subject.id,
        identityType: 'employee',
        placements: [plc(staffVertical, staffLevel)],
        reason: 'HR maps a new hire',
      }),
    );

    // The HR case is created with the suggestion, in the same write.
    expect(row.hrCaseId).toBeTruthy();
    const hrCase = await unscopedPrisma.hrCase.findUniqueOrThrow({ where: { id: row.hrCaseId! } });
    expect(hrCase.tenantId).toBe(tid);
    expect(hrCase.category).toBe('access_mapping');
    expect(hrCase.confidential).toBe(true);
    expect(hrCase.raisedByPartyId).toBe(hrId);

    const refused = await asHr(() => expectReject(() => confirmAssignment({ assignmentId: row.id, reason: 'self' })));
    expect(refused.status).toBe(403);
    expect((await unscopedPrisma.accessAssignment.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
      'suggested',
    );

    const confirmed = await asFounder(() =>
      confirmAssignment({ assignmentId: row.id, reason: 'founder confirms HR mapping' }),
    );
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.confirmedById).not.toBe(hrId);

    const stillCase = await unscopedPrisma.hrCase.findUniqueOrThrow({ where: { id: row.hrCaseId! } });
    expect(stillCase.category).toBe('access_mapping');
    expect(stillCase.confidential).toBe(true);
  });

  it('a suggestion by someone other than HR carries no HR case', async () => {
    const subject = await makePerson(tid);
    const row = await asFounder(() =>
      suggestAssignment({
        personId: subject.id,
        identityType: 'employee',
        placements: [plc(staffVertical, staffLevel)],
        reason: 'founder maps directly',
      }),
    );
    expect(row.hrCaseId).toBeNull();
  });

  it('a suggestion may link an existing access_mapping case, and refuses a case of another category', async () => {
    const subject = await makePerson(tid);
    const mapping = await unscopedPrisma.hrCase.create({
      data: {
        tenantId: tid,
        recordCode: `CASE-PR12-${subject.id.slice(-6)}`,
        category: 'access_mapping',
        subject: 'Access mapping for a hire',
        raisedByPartyId: hrId,
        confidential: true,
        slaDueAt: new Date(Date.now() + 96 * 3_600_000),
      },
    });
    const linked = await asHr(() =>
      suggestAssignment({
        personId: subject.id,
        identityType: 'employee',
        placements: [plc(staffVertical, staffLevel)],
        reason: 'links the existing case',
        hrCaseId: mapping.id,
      }),
    );
    expect(linked.hrCaseId).toBe(mapping.id);

    const payroll = await unscopedPrisma.hrCase.create({
      data: {
        tenantId: tid,
        recordCode: `CASE-PR12P-${subject.id.slice(-6)}`,
        category: 'payroll',
        subject: 'A payslip query',
        raisedByPartyId: hrId,
        slaDueAt: new Date(Date.now() + 96 * 3_600_000),
      },
    });
    const before = await unscopedPrisma.accessAssignment.count({ where: { tenantId: tid, personId: subject.id } });
    const err = await asHr(() =>
      expectReject(() =>
        suggestAssignment({
          personId: subject.id,
          identityType: 'employee',
          placements: [plc(staffVertical, staffLevel)],
          reason: 'wrong category',
          hrCaseId: payroll.id,
        }),
      ),
    );
    expect(err.status).toBe(422);
    expect(await unscopedPrisma.accessAssignment.count({ where: { tenantId: tid, personId: subject.id } })).toBe(
      before,
    );
  });
});
