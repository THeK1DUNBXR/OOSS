/**
 * The board (equity-portal plan §6, phase 3).
 *
 * Requirements named `EQT-BRD-*`, per the phase-3 brief in
 * `docs/plan/equity-portal.md` §6. Every quorum/threshold rule reads the
 * *whole tenant's* active directors, so each test that cares about a count
 * gets its own freshly bootstrapped tenant rather than sharing one — the same
 * reason `EQT-IDN-001` bootstraps a subsidiary instead of reusing `kaizen`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addBoardMember,
  callMeeting,
  castVote,
  closeCirculation,
  complianceCalendar,
  enterMinutes,
  listMeetings,
  markHeld,
  meeting,
  openForCirculation,
  proposeResolution,
  recordAttendance,
  recordMgt14,
  resolution,
  runBoardComplianceJob,
} from '../domains/board.js';
import { seedBootstrap } from '../seed/bootstrap.js';
import { asPrincipal, authFor, prisma as scopedPrisma, expectReject, tenantId, unscopedPrisma } from './helpers.js';
import type { AuthContext } from '../platform/context.js';

const DAY_MS = 86_400_000;

let HOLDING: string;
const cleanupTenantSlugs: string[] = [];
let tenantCounter = 0;

/** A synthetic auth context for a board role — no real User/Affiliation row
 *  is needed, since `assertCan` resolves the grant from the tenant's seeded
 *  `AccessRole`/`Grant` rows by `roleSlug` alone. */
function boardAuth(tid: string, roleSlug: string, partyId = `test-party-${roleSlug}`): AuthContext {
  return authFor({ tenantId: tid, partyId, userId: `test-user-${roleSlug}`, affiliationId: `test-aff-${roleSlug}`, roleSlug, branch: null });
}

/** A freshly bootstrapped, empty tenant — so a test that cares about the
 *  active-director count, or wants a genuinely empty compliance register,
 *  never shares one with another test's fixtures. */
async function newTenant(label: string): Promise<string> {
  tenantCounter += 1;
  const slug = `board-test-${label}-${Date.now()}-${tenantCounter}`;
  cleanupTenantSlugs.push(slug);
  const { tenantId: id } = await seedBootstrap({ tenantSlug: slug, tenantName: `Board Test ${label}` });
  return id;
}

async function makePerson(tid: string, name: string) {
  return scopedPrisma.person.create({
    data: {
      tenantId: tid,
      recordCode: `PER-BRD-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
      fullName: name,
      source: 'test',
    },
  });
}

/** Adds `count` active directors to `tid` and returns their board member rows. */
async function addDirectors(tid: string, count: number) {
  const chairman = boardAuth(tid, 'chairman');
  const members: Awaited<ReturnType<typeof addBoardMember>>[] = [];
  for (let i = 0; i < count; i++) {
    const person = await asPrincipal(chairman, () => makePerson(tid, `Director ${i + 1}`));
    const member = await asPrincipal(chairman, () =>
      addBoardMember({ personId: person.id, role: 'director', appointedOn: new Date(Date.now() - 365 * DAY_MS) }),
    );
    members.push(member);
  }
  return members;
}

beforeAll(async () => {
  HOLDING = await tenantId();
});

afterAll(async () => {
  const tenants = await unscopedPrisma.tenant.findMany({ where: { slug: { in: cleanupTenantSlugs } } });
  for (const t of tenants) {
    await unscopedPrisma.exceptionRecord.deleteMany({ where: { tenantId: t.id } }).catch(() => {});
    await unscopedPrisma.tenant.delete({ where: { id: t.id } }).catch(() => {});
  }
});

describe('EQT-BRD-001 — a meeting called on short notice is refused unless consent with a reason is recorded', () => {
  it('two days notice is refused; the same call with recorded consent and a reason succeeds', async () => {
    const tid = await newTenant('001');
    const chairman = boardAuth(tid, 'chairman');
    await addDirectors(tid, 2);

    const scheduledFor = new Date(Date.now() + 2 * DAY_MS);
    const rejection = await expectReject(() =>
      asPrincipal(chairman, () => callMeeting({ kind: 'board', title: 'Q3 review', scheduledFor, mode: 'vc' })),
    );
    expect(rejection.message).toMatch(/clear days/);

    // Refused again with no reason attached to the consent.
    const noReason = await expectReject(() =>
      asPrincipal(chairman, () =>
        callMeeting({ kind: 'board', title: 'Q3 review', scheduledFor, mode: 'vc', shortNoticeConsent: { reason: '' } }),
      ),
    );
    expect(noReason.message).toMatch(/clear days/);

    const withConsent = await asPrincipal(chairman, () =>
      callMeeting({
        kind: 'board',
        title: 'Q3 review',
        scheduledFor,
        mode: 'vc',
        shortNoticeConsent: { reason: 'All directors available only this week.' },
      }),
    );
    expect(withConsent.status).toBe('called');
    const agenda = withConsent.agenda as Array<{ title: string; notes?: string }>;
    const consentItem = agenda.find((a) => a.title === 'Short-notice consent recorded');
    expect(consentItem?.notes).toMatch(/All directors available only this week\./);
  });
});

describe('EQT-BRD-002 — a meeting without quorum cannot be marked held', () => {
  it('two of seven present is short of quorum; a third attendee clears it', async () => {
    const tid = await newTenant('002');
    const chairman = boardAuth(tid, 'chairman');
    // s.174 quorum for 7 directors: max(2, ceil(7/3)) = 3.
    const members = await addDirectors(tid, 7);

    const meetingRow = await asPrincipal(chairman, () =>
      callMeeting({ kind: 'board', title: 'Annual review', scheduledFor: new Date(Date.now() + 10 * DAY_MS), mode: 'physical' }),
    );
    expect(meetingRow.quorumRequired).toBe(3);

    await asPrincipal(chairman, () =>
      recordAttendance(meetingRow.id, [
        { boardMemberId: members[0].id, present: true },
        { boardMemberId: members[1].id, present: true },
        { boardMemberId: members[2].id, present: false },
      ]),
    );
    const shortOfQuorum = await expectReject(() => asPrincipal(chairman, () => markHeld(meetingRow.id)));
    expect(shortOfQuorum.message).toMatch(/s\.174/);

    await asPrincipal(chairman, () =>
      recordAttendance(meetingRow.id, [
        { boardMemberId: members[0].id, present: true },
        { boardMemberId: members[1].id, present: true },
        { boardMemberId: members[2].id, present: true },
      ]),
    );
    const held = await asPrincipal(chairman, () => markHeld(meetingRow.id));
    expect(held.status).toBe('held');
  });
});

describe('EQT-BRD-003 — a section 179(3) subject cannot be passed by circulation', () => {
  it('an allotment resolution refuses circulation and accepts a meeting resolution instead', async () => {
    const chairman = boardAuth(HOLDING, 'chairman');

    const rejection = await expectReject(() =>
      asPrincipal(chairman, () =>
        proposeResolution({
          kind: 'board',
          subject: 'allotment',
          title: 'Allot 1,000 equity shares',
          text: 'Resolved that the company allot 1,000 equity shares.',
          passedBy: 'circulation',
        }),
      ),
    );
    expect(rejection.message).toMatch(/179\(3\)/);

    const proposed = await asPrincipal(chairman, () =>
      proposeResolution({
        kind: 'board',
        subject: 'allotment',
        title: 'Allot 1,000 equity shares',
        text: 'Resolved that the company allot 1,000 equity shares.',
        passedBy: 'meeting',
      }),
    );
    expect(proposed.requiresMeeting).toBe(true);
    expect(proposed.passedBy).toBe('meeting');
  });
});

describe("EQT-BRD-004 — an interested director's vote is recorded as abstained and excluded from the count", () => {
  it('the interested vote becomes an abstention, and the majority is of the entitled remainder', async () => {
    const tid = await newTenant('004');
    const chairman = boardAuth(tid, 'chairman');
    const [a, b, c] = await addDirectors(tid, 3);

    const proposed = await asPrincipal(chairman, () =>
      proposeResolution({
        kind: 'board',
        subject: 'general',
        title: 'Approve vendor contract',
        text: 'Resolved that the company enters the vendor contract.',
        passedBy: 'circulation',
      }),
    );
    await asPrincipal(chairman, () => openForCirculation(proposed.id, { dispatchProofRef: 'EMAIL-2026-09-14' }));

    await asPrincipal(chairman, () => castVote(proposed.id, { boardMemberId: a.id, choice: 'for', interested: true }));
    await asPrincipal(chairman, () => castVote(proposed.id, { boardMemberId: b.id, choice: 'for' }));
    await asPrincipal(chairman, () => castVote(proposed.id, { boardMemberId: c.id, choice: 'for' }));

    const closed = await asPrincipal(chairman, () => closeCirculation(proposed.id));
    expect(closed.outcome).toBe('passed');

    const withVotes = await asPrincipal(chairman, () => resolution(proposed.id));
    const interestedVote = withVotes.votes.find((v) => v.boardMemberId === a.id);
    expect(interestedVote?.choice).toBe('abstain');
    expect(interestedVote?.abstainedAsInterested).toBe(true);
  });
});

describe('EQT-BRD-005 — a third of the board demanding a meeting closes the circulation as meeting demanded', () => {
  it('two of six members demanding a meeting is exactly the s.175 threshold', async () => {
    const tid = await newTenant('005');
    const chairman = boardAuth(tid, 'chairman');
    const members = await addDirectors(tid, 6); // meetingDemandThreshold(6) = ceil(6/3) = 2

    const proposed = await asPrincipal(chairman, () =>
      proposeResolution({
        kind: 'board',
        subject: 'general',
        title: 'Approve office lease renewal',
        text: 'Resolved that the lease is renewed on the terms circulated.',
        passedBy: 'circulation',
      }),
    );
    await asPrincipal(chairman, () => openForCirculation(proposed.id, { dispatchProofRef: 'EMAIL-2026-09-14' }));

    await asPrincipal(chairman, () => castVote(proposed.id, { boardMemberId: members[0].id, choice: 'against', demandsMeeting: true }));
    await asPrincipal(chairman, () => castVote(proposed.id, { boardMemberId: members[1].id, choice: 'against', demandsMeeting: true }));
    await asPrincipal(chairman, () => castVote(proposed.id, { boardMemberId: members[2].id, choice: 'for' }));

    const closed = await asPrincipal(chairman, () => closeCirculation(proposed.id));
    expect(closed.outcome).toBe('meeting_demanded');
  });
});

describe('EQT-BRD-006 — minutes entered after thirty days are recorded as late, never silently', () => {
  it('an entry forty days after the meeting is refused without `late: true`, and recorded with a reason once given', async () => {
    const tid = await newTenant('006');
    const chairman = boardAuth(tid, 'chairman');
    const members = await addDirectors(tid, 2); // quorum = 2

    const meetingRow = await asPrincipal(chairman, () =>
      callMeeting({ kind: 'board', title: 'Budget review', scheduledFor: new Date(Date.now() + 10 * DAY_MS), mode: 'physical' }),
    );
    await asPrincipal(chairman, () =>
      recordAttendance(meetingRow.id, [
        { boardMemberId: members[0].id, present: true },
        { boardMemberId: members[1].id, present: true },
      ]),
    );
    const heldOn = new Date(Date.now() - 40 * DAY_MS);
    await asPrincipal(chairman, () => markHeld(meetingRow.id, heldOn));

    const refused = await expectReject(() => asPrincipal(chairman, () => enterMinutes(meetingRow.id)));
    expect(refused.message).toMatch(/30 days/);
    expect(refused.message).toMatch(/late: true/);

    const missingReason = await expectReject(() => asPrincipal(chairman, () => enterMinutes(meetingRow.id, { late: true })));
    expect(missingReason.message).toMatch(/reason/);

    const entered = await asPrincipal(chairman, () =>
      enterMinutes(meetingRow.id, { late: true, reason: 'Company secretary was on leave.' }),
    );
    expect(entered.status).toBe('minutes_entered');

    const audit = await unscopedPrisma.auditRecord.findFirst({
      where: { tenantId: tid, subjectType: 'board_meeting', subjectId: meetingRow.id, action: 'update' },
      orderBy: { timestamp: 'desc' },
    });
    expect(audit).toBeTruthy();
    const diff = audit?.diff as { late?: { to?: boolean }; reason?: { to?: string } } | null;
    expect(diff?.late?.to).toBe(true);
    expect(diff?.reason?.to).toBe('Company secretary was on leave.');
  });
});

describe("EQT-BRD-007 — the compliance job writes each item once and reads 'No meeting recorded' rather than overdue on an empty register", () => {
  it('an empty register raises nothing; once incorporation is on record the job raises one item, never twice', async () => {
    const tid = await newTenant('007');
    const chairman = boardAuth(tid, 'chairman');

    // Nothing recorded at all: no meeting, no incorporation date. The job
    // must say nothing rather than fabricate a due date from a guess.
    const raisedFromEmpty = await asPrincipal(chairman, () => runBoardComplianceJob());
    expect(raisedFromEmpty).toBe(0);
    const emptyCalendar = await asPrincipal(chairman, () => complianceCalendar());
    expect(emptyCalendar).toHaveLength(0);
    expect(emptyCalendar.some((i) => i.overdue)).toBe(false);

    // Incorporation is now on record: the job can compute a due date, and
    // does — but it is a future date, not a fabricated "overdue".
    await asPrincipal(chairman, () =>
      scopedPrisma.companyProfile.create({
        data: { tenantId: tid, legalName: 'Board Test 007', incorporatedOn: new Date(Date.now() - 5 * DAY_MS) },
      }),
    );
    const raisedOnce = await asPrincipal(chairman, () => runBoardComplianceJob());
    expect(raisedOnce).toBe(1);

    const calendarAfterFirst = await asPrincipal(chairman, () => complianceCalendar());
    const firstMeetingItems = calendarAfterFirst.filter((i) => i.kind === 'board_first_meeting');
    expect(firstMeetingItems).toHaveLength(1);
    expect(firstMeetingItems[0].overdue).toBe(false);

    // Run again the same day: `raised` counts what the sweep considered, not
    // what it wrote — the unique (kind, related, dueOn) key is what actually
    // guards the table, so what is asserted here is the row count staying at
    // one, never a duplicate.
    await asPrincipal(chairman, () => runBoardComplianceJob());
    const calendarAfterSecond = await asPrincipal(chairman, () => complianceCalendar());
    expect(calendarAfterSecond.filter((i) => i.kind === 'board_first_meeting')).toHaveLength(1);
  });
});

describe('EQT-BRD-008 — a shareholder sees no board meetings and a director sees them; a cross-tenant read is 404', () => {
  it('grant and tenancy both gate the read, independently', async () => {
    const tid = await newTenant('008');
    const chairman = boardAuth(tid, 'chairman');
    const meetingRow = await asPrincipal(chairman, () =>
      callMeeting({ kind: 'board', title: 'Ordinary board meeting', scheduledFor: new Date(Date.now() + 10 * DAY_MS), mode: 'vc' }),
    );

    const shareholder = boardAuth(tid, 'shareholder');
    const denied = await expectReject(() => asPrincipal(shareholder, () => listMeetings()));
    expect(denied.status).toBe(403);

    const director = boardAuth(tid, 'director');
    const items = await asPrincipal(director, () => listMeetings());
    expect(items.some((m) => m.id === meetingRow.id)).toBe(true);

    const otherTenantDirector = boardAuth(HOLDING, 'director');
    const crossTenant = await expectReject(() => asPrincipal(otherTenantDirector, () => meeting(meetingRow.id)));
    expect(crossTenant.status).toBe(404);
  });
});

describe('EQT-BRD-009 — a passed special resolution raises the MGT-14 item and recording the SRN closes it', () => {
  it('the item opens when the resolution passes and closes when the filing is recorded', async () => {
    const tid = await newTenant('009');
    const chairman = boardAuth(tid, 'chairman');
    const [a, b] = await addDirectors(tid, 2);

    const proposed = await asPrincipal(chairman, () =>
      proposeResolution({
        kind: 'shareholder_special',
        subject: 'general',
        title: 'Alter the articles of association',
        text: 'Resolved as a special resolution that the articles be altered as circulated.',
        passedBy: 'circulation',
      }),
    );
    await asPrincipal(chairman, () => openForCirculation(proposed.id, { dispatchProofRef: 'EMAIL-2026-09-14' }));
    await asPrincipal(chairman, () => castVote(proposed.id, { boardMemberId: a.id, choice: 'for' }));
    await asPrincipal(chairman, () => castVote(proposed.id, { boardMemberId: b.id, choice: 'for' }));
    const closed = await asPrincipal(chairman, () => closeCirculation(proposed.id));
    expect(closed.outcome).toBe('passed');

    const calendarBefore = await asPrincipal(chairman, () => complianceCalendar());
    const mgt14Item = calendarBefore.find((i) => i.kind === 'mgt14_30d' && i.relatedId === proposed.id);
    expect(mgt14Item?.status).toBe('open');

    await asPrincipal(chairman, () => recordMgt14(proposed.id, 'SRN12345678', new Date()));

    const calendarAfter = await asPrincipal(chairman, () => complianceCalendar());
    const closedItem = calendarAfter.find((i) => i.kind === 'mgt14_30d' && i.relatedId === proposed.id);
    expect(closedItem?.status).toBe('done');
  });
});
