/**
 * Technology — service desk (docs/plan/cio.md, workstream D).
 *
 * `dueFrom`/`slaAttainment`/`medianMinutes` first, without a database — pure
 * arithmetic tested against known inputs. Then the wiring: triage stamps
 * clocks from the policy in force on the ticket's own creation date
 * (IT-SLA-001), an employee sees only their own tickets and cannot triage
 * or assign (IT-TKT-001), the SLA breach job fires once per clock
 * (IT-TKT-002), only the requester may rate a resolved ticket and only once
 * (IT-TKT-003), and SLA attainment reports "not yet measured" rather than a
 * false 100% with no closed tickets in the period (IT-TKT-004).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { dueFrom, slaAttainment, medianMinutes, backlogAgeBuckets } from '@kaizen/shared';
import { asUser, asPrincipal, authFor, expectReject, prisma, tenantId, unscopedPrisma, type TestPrincipal } from '../helpers.js';
import { seedBootstrap } from '../../seed/bootstrap.js';
import {
  createTicket,
  listTickets,
  getTicket,
  triageTicket,
  assignTicket,
  transitionTicket,
  addComment,
  rateTicket,
  createKnowledgeArticle,
  publishKnowledgeArticle,
  markKnowledgeHelpful,
  listKnowledge,
  myIt,
  summary,
  setSlaPolicy,
} from '../../domains/it/servicedesk.js';
import { runServicedeskJob } from '../../jobs/it/servicedesk.js';

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

describe('dueFrom / slaAttainment / medianMinutes (pure arithmetic, no DB)', () => {
  it('IT-SLA-ARITH-001: with businessHoursOnly false, due is plain calendar time', () => {
    const created = new Date('2026-09-14T10:00:00.000Z');
    const due = dueFrom(created, 120, false);
    expect(due.toISOString()).toBe('2026-09-14T12:00:00.000Z');
  });

  it('IT-SLA-ARITH-002: a business-hours budget raised mid-morning IST stays inside the same day', () => {
    // 2026-09-14 is a Monday. 09:00 IST = 03:30 UTC.
    const created = new Date('2026-09-14T05:00:00.000Z'); // 10:30 IST
    const due = dueFrom(created, 60, true); // due 11:30 IST = 06:00 UTC
    expect(due.toISOString()).toBe('2026-09-14T06:00:00.000Z');
  });

  it('IT-SLA-ARITH-003: a business-hours budget raised near end of day rolls to the next business day', () => {
    // 2026-09-14 (Monday) 17:30 IST = 12:00 UTC. A 4-hour budget has only 30
    // minutes left today (until 18:00 IST) and needs 3h30 more the next
    // business day, landing at 12:30 IST Tuesday = 07:00 UTC.
    const created = new Date('2026-09-14T12:00:00.000Z');
    const due = dueFrom(created, 4 * 60, true);
    expect(due.toISOString()).toBe('2026-09-15T07:00:00.000Z');
  });

  it('IT-SLA-ARITH-004: raised on a Saturday snaps to Monday business hours before the clock runs', () => {
    // 2026-09-19 is a Saturday.
    const created = new Date('2026-09-19T10:00:00.000Z');
    const due = dueFrom(created, 30, true);
    // Monday 2026-09-21, 09:30 IST = 04:00 UTC.
    expect(due.toISOString()).toBe('2026-09-21T04:00:00.000Z');
  });

  it('IT-SLA-ARITH-005: a budget spanning a weekend skips Saturday and Sunday entirely', () => {
    // Friday 2026-09-18, 17:00 IST = 11:30 UTC. 9 hours of business time left
    // today is 1 hour (until 18:00 IST); the remaining 8 hours resume Monday
    // 09:00 IST, landing at 17:00 IST Monday = 11:30 UTC.
    const created = new Date('2026-09-18T11:30:00.000Z');
    const due = dueFrom(created, 9 * 60, true);
    expect(due.toISOString()).toBe('2026-09-21T11:30:00.000Z');
  });

  it('IT-SLA-ARITH-006: slaAttainment is null with no rows, and a percentage otherwise', () => {
    expect(slaAttainment([])).toBeNull();
    expect(slaAttainment([{ met: true }, { met: true }, { met: false }, { met: true }])).toBe(75);
  });

  it('IT-SLA-ARITH-007: medianMinutes handles even and odd counts, and null on empty', () => {
    expect(medianMinutes([])).toBeNull();
    expect(medianMinutes([10])).toBe(10);
    expect(medianMinutes([30, 10, 20])).toBe(20);
    expect(medianMinutes([10, 20, 30, 40])).toBe(25);
  });

  it('IT-SLA-ARITH-008: backlogAgeBuckets sorts by whole days old', () => {
    const now = new Date('2026-09-14T00:00:00.000Z');
    const buckets = backlogAgeBuckets(
      [
        new Date('2026-09-14T00:00:00.000Z'), // 0 days
        new Date('2026-09-10T00:00:00.000Z'), // 4 days
        new Date('2026-09-01T00:00:00.000Z'), // 13 days
        new Date('2026-07-01T00:00:00.000Z'), // >30 days
      ],
      now,
    );
    expect(buckets).toEqual({ d0_1: 1, d2_7: 1, d8_30: 1, d30plus: 1 });
  });
});

describe('service desk — domain and wiring', () => {
  let tid: string;
  let employeePartyId: string;
  let opsPartyId: string;

  beforeAll(async () => {
    tid = await tenantId();
    const employee = await unscopedPrisma.user.findFirstOrThrow({ where: { email: 'employee@kaizen.co.in', tenant: { slug: 'kaizen' } } });
    employeePartyId = employee.personId;
    const ops = await unscopedPrisma.user.findFirstOrThrow({ where: { email: 'operations@kaizen.co.in', tenant: { slug: 'kaizen' } } });
    opsPartyId = ops.personId;
  });

  it('IT-SLA-001: triage stamps due times from the policy in force on the ticket\'s creation date, not today\'s', async () => {
    // A policy from the year 2000, well before the seeded 2024-01-01 table —
    // the only one in force for a ticket created in 2010.
    const oldPolicy = await asUser('operations@kaizen.co.in', () =>
      setSlaPolicy({
        priority: 'P1',
        responseMinutes: 999,
        resolutionMinutes: 9999,
        businessHoursOnly: false,
        effectiveFrom: new Date('2000-01-01T00:00:00.000Z'),
        note: 'IT-SLA-001 fixture — an old rate, not today\'s.',
      }),
    );
    expect(oldPolicy.responseMinutes).toBe(999);

    const backdated = await unscopedPrisma.itTicket.create({
      data: {
        tenantId: tid,
        recordCode: `TKT-SLA001-${stamp()}`,
        requesterPartyId: employeePartyId,
        category: 'incident',
        subject: 'IT-SLA-001 fixture',
        description: 'Backdated to 2010 so only the year-2000 policy is in force.',
        status: 'new',
        createdAt: new Date('2010-06-15T04:00:00.000Z'),
      },
    });

    const triaged = await asUser('operations@kaizen.co.in', () => triageTicket(backdated.id, { priority: 'P1' }));

    expect(triaged.respondDueAt).not.toBeNull();
    const expectedDue = dueFrom(backdated.createdAt, 999, false);
    expect(triaged.respondDueAt!.toISOString()).toBe(expectedDue.toISOString());

    // Not today's P1 policy (30 minutes, business hours only) — if it had
    // used today's table this would be a completely different timestamp.
    const wrongIfUsingTodaysTable = dueFrom(backdated.createdAt, 30, true);
    expect(triaged.respondDueAt!.toISOString()).not.toBe(wrongIfUsingTodaysTable.toISOString());
  });

  // IT-TKT-004 (SLA attainment reports not yet measured with no closed
  // tickets in the period) needs a tenant it controls completely — the
  // shared "kaizen" tenant used by every other test in this file may
  // already have a this-month-closed ticket by the time this runs, from
  // another suite entirely (the overview/health tests, or a future one).
  // See the isolated-tenant describe block at the end of this file.

  it('permission: an employee cannot read fleet-wide SLA figures — summary() needs `all` scope, not `own`', async () => {
    const denied = await expectReject(() => asUser('employee@kaizen.co.in', () => summary()));
    expect(denied.status).toBe(403);
    expect(denied.message).toMatch(/all/i);
  });

  it('IT-TKT-001: an employee sees only tickets they raised (or are assigned), can raise one, and cannot assign or triage', async () => {
    const mine = await asUser('priya@kaizen.co.in', () =>
      createTicket({ category: 'question', subject: `Priya's ticket ${stamp()}`, description: 'Needs a VPN profile.' }),
    );
    expect(mine.requesterPartyId).toBeTruthy();

    const someoneElses = await asUser('divya@kaizen.co.in', () =>
      createTicket({ category: 'incident', subject: `Divya's ticket ${stamp()}`, description: 'Laptop will not boot.' }),
    );

    const priyaList = await asUser('priya@kaizen.co.in', () => listTickets({ tab: 'mine' }));
    expect(priyaList.some((t) => t.id === mine.id)).toBe(true);
    expect(priyaList.some((t) => t.id === someoneElses.id)).toBe(false);

    const seeingAnothers = await expectReject(() => asUser('priya@kaizen.co.in', () => getTicket(someoneElses.id)));
    expect(seeingAnothers.status).toBe(403);

    const cannotTriage = await expectReject(() => asUser('priya@kaizen.co.in', () => triageTicket(mine.id, { priority: 'P3' })));
    expect(cannotTriage.status).toBe(403);

    const cannotAssign = await expectReject(() => asUser('priya@kaizen.co.in', () => assignTicket(mine.id, employeePartyId)));
    expect(cannotAssign.status).toBe(403);
  });

  it('IT-TKT-002: the SLA breach job raises one exception per clock, and a re-run raises none new', async () => {
    const ticket = await asUser('employee@kaizen.co.in', () =>
      createTicket({ category: 'incident', subject: `Breach fixture ${stamp()}`, description: 'Printer offline.' }),
    );
    await asUser('operations@kaizen.co.in', () => triageTicket(ticket.id, { priority: 'P1' }));

    // Force both clocks into the past so the job sees them as breached
    // without waiting real time out.
    await unscopedPrisma.itTicket.update({
      where: { id: ticket.id },
      data: { respondDueAt: new Date(Date.now() - 60_000), resolveDueAt: new Date(Date.now() - 60_000) },
    });

    await asUser('operations@kaizen.co.in', () => runServicedeskJob());
    const afterFirst = await unscopedPrisma.exceptionRecord.count({
      where: { tenantId: tid, subjectType: 'it_ticket', subjectId: ticket.id, code: { in: ['IT_TICKET_RESPONSE_BREACHED', 'IT_TICKET_RESOLUTION_BREACHED'] } },
    });
    expect(afterFirst).toBe(2); // one per clock

    await asUser('operations@kaizen.co.in', () => runServicedeskJob());
    const afterSecond = await unscopedPrisma.exceptionRecord.count({
      where: { tenantId: tid, subjectType: 'it_ticket', subjectId: ticket.id, code: { in: ['IT_TICKET_RESPONSE_BREACHED', 'IT_TICKET_RESOLUTION_BREACHED'] } },
    });
    expect(afterSecond).toBe(2); // idempotent — nothing new

    const refreshed = await unscopedPrisma.itTicket.findFirstOrThrow({ where: { id: ticket.id } });
    expect(refreshed.slaBreachNotified.sort()).toEqual(['resolution', 'response']);
  });

  it('IT-TKT-003: only the requester can rate a resolved ticket, and only once', async () => {
    const ticket = await asUser('employee@kaizen.co.in', () =>
      createTicket({ category: 'request', subject: `Rating fixture ${stamp()}`, description: 'New monitor please.' }),
    );
    await asUser('operations@kaizen.co.in', () => triageTicket(ticket.id, { priority: 'P4' }));
    await asUser('operations@kaizen.co.in', () => assignTicket(ticket.id, opsPartyId));
    await asUser('operations@kaizen.co.in', () => transitionTicket(ticket.id, 'START'));
    await asUser('operations@kaizen.co.in', () => transitionTicket(ticket.id, 'RESOLVE'));

    const notRequester = await expectReject(() => asUser('operations@kaizen.co.in', () => rateTicket(ticket.id, 5)));
    expect(notRequester.status).toBe(403);

    const rated = await asUser('employee@kaizen.co.in', () => rateTicket(ticket.id, 4));
    expect(rated.satisfaction).toBe(4);

    const again = await expectReject(() => asUser('employee@kaizen.co.in', () => rateTicket(ticket.id, 5)));
    expect(again.status).toBe(409);

    const stillFour = await unscopedPrisma.itTicket.findFirstOrThrow({ where: { id: ticket.id } });
    expect(stillFour.satisfaction).toBe(4);
  });

  it('permission: an employee cannot see or act on another employee\'s ticket via comments', async () => {
    const ticket = await asUser('ravi@kaizen.co.in', () =>
      createTicket({ category: 'question', subject: `Ravi's private ticket ${stamp()}`, description: 'Password reset.' }),
    );
    const denied = await expectReject(() => asUser('divya@kaizen.co.in', () => addComment(ticket.id, { body: 'Can I help?' })));
    expect(denied.status).toBe(403);
  });

  it('permission: the requester cannot leave an internal comment, but an assigned desk role can', async () => {
    const ticket = await asUser('employee@kaizen.co.in', () =>
      createTicket({ category: 'incident', subject: `Internal comment fixture ${stamp()}`, description: 'VPN down.' }),
    );
    const deniedInternal = await expectReject(() => asUser('employee@kaizen.co.in', () => addComment(ticket.id, { body: 'internal note', internal: true }))
    );
    expect(deniedInternal.status).toBe(403);

    const publicOk = await asUser('employee@kaizen.co.in', () => addComment(ticket.id, { body: 'Still broken.' }));
    expect(publicOk.internal).toBe(false);

    const opsInternal = await asUser('operations@kaizen.co.in', () => addComment(ticket.id, { body: 'checking VPN concentrator', internal: true }));
    expect(opsInternal.internal).toBe(true);

    // The requester never sees the internal note in the detail view.
    const detail = await asUser('employee@kaizen.co.in', () => getTicket(ticket.id));
    expect(detail.comments.some((c) => c.body === 'checking VPN concentrator')).toBe(false);
    const opsDetail = await asUser('operations@kaizen.co.in', () => getTicket(ticket.id));
    expect(opsDetail.comments.some((c) => c.body === 'checking VPN concentrator')).toBe(true);
  });

  it('the ticket lifecycle machine runs new -> triaged -> in_progress -> waiting -> resolved -> closed, plus reopen', async () => {
    const ticket = await asUser('employee@kaizen.co.in', () =>
      createTicket({ category: 'incident', subject: `Lifecycle fixture ${stamp()}`, description: 'Wifi down in Chennai office.' }),
    );
    expect(ticket.status).toBe('new');

    const triaged = await asUser('operations@kaizen.co.in', () => triageTicket(ticket.id, { priority: 'P2' }));
    expect(triaged.status).toBe('triaged');

    await asUser('operations@kaizen.co.in', () => assignTicket(ticket.id, opsPartyId));
    const started = await asUser('operations@kaizen.co.in', () => transitionTicket(ticket.id, 'START'));
    expect(started.status).toBe('in_progress');
    expect(started.firstRespondedAt).not.toBeNull();

    const waiting = await asUser('operations@kaizen.co.in', () => transitionTicket(ticket.id, 'WAIT'));
    expect(waiting.status).toBe('waiting');
    expect(waiting.waitingSince).not.toBeNull();

    const resumed = await asUser('operations@kaizen.co.in', () => transitionTicket(ticket.id, 'RESUME'));
    expect(resumed.status).toBe('in_progress');
    expect(resumed.waitingSince).toBeNull();

    const resolved = await asUser('operations@kaizen.co.in', () => transitionTicket(ticket.id, 'RESOLVE'));
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolvedAt).not.toBeNull();

    const reopened = await asUser('operations@kaizen.co.in', () => transitionTicket(ticket.id, 'REOPEN'));
    expect(reopened.status).toBe('in_progress');

    // disposed-from-assigned-style illegal jump: cannot close from in_progress.
    const illegal = await expectReject(() => asUser('operations@kaizen.co.in', () => transitionTicket(ticket.id, 'CLOSE')));
    expect(illegal.status).toBe(422);

    const resolvedAgain = await asUser('operations@kaizen.co.in', () => transitionTicket(ticket.id, 'RESOLVE'));
    const closed = await asUser('operations@kaizen.co.in', () => transitionTicket(resolvedAgain.id, 'CLOSE'));
    expect(closed.status).toBe('closed');

    // closed is terminal — nothing reopens it.
    const noReopen = await expectReject(() => asUser('operations@kaizen.co.in', () => transitionTicket(closed.id, 'REOPEN')));
    expect(noReopen.status).toBe(422);
  });

  it('knowledge base: draft is invisible to an employee, publishing makes it visible, and helpful increments', async () => {
    const article = await asUser('operations@kaizen.co.in', () =>
      createKnowledgeArticle({ title: `How to reset your VPN ${stamp()}`, body: 'Open the VPN client and click reset.' }),
    );
    expect(article.status).toBe('draft');

    const invisible = await asUser('employee@kaizen.co.in', () => listKnowledge());
    expect(invisible.some((a) => a.id === article.id)).toBe(false);

    const published = await asUser('operations@kaizen.co.in', () => publishKnowledgeArticle(article.id));
    expect(published.status).toBe('published');
    expect(published.publishedAt).not.toBeNull();

    const visible = await asUser('employee@kaizen.co.in', () => listKnowledge());
    expect(visible.some((a) => a.id === article.id)).toBe(true);

    const helped = await asUser('employee@kaizen.co.in', () => markKnowledgeHelpful(article.id));
    expect(helped.helpfulCount).toBe(1);
  });

  it('My IT composes only the caller\'s own tickets, and carries the awaiting note rather than reaching into other workstreams', async () => {
    const ticket = await asUser('employee@kaizen.co.in', () =>
      createTicket({ category: 'question', subject: `My IT fixture ${stamp()}`, description: 'How do I request a licence?' }),
    );
    const mine = await asUser('employee@kaizen.co.in', () => myIt());
    expect(mine.tickets.some((t) => t.id === ticket.id)).toBe(true);
    expect(mine.policiesAwaiting).toEqual([]);
    expect(mine.assets).toEqual([]);
    expect(typeof mine.note).toBe('string');
  });

  it('permission: the Finance Head holds only view on tickets and cannot raise one', async () => {
    const denied = await expectReject(() =>
      asUser('finance@kaizen.co.in', () => createTicket({ category: 'question', subject: 'nope', description: 'nope' })),
    );
    expect(denied.status).toBe(403);
  });
});

/**
 * IT-TKT-004 needs a tenant it controls completely — "no closed tickets in
 * the period" is meaningless against the shared "kaizen" tenant every other
 * test in this file runs against, which another suite (or a future test)
 * may already have closed a ticket in this month. So, the same as
 * `overview.test.ts`'s IT-HLT-001, this bootstraps its own tenant
 * (`seedBootstrap`, which seeds `ItSlaPolicy` for it the same as any other
 * tenant) and runs entirely inside it via `asPrincipal`/`authFor`.
 */
describe('IT-TKT-004: SLA attainment reports not yet measured with no closed tickets in the period', () => {
  let ttid: string;
  let chairman: TestPrincipal;

  async function asTenantChairman<T>(fn: () => Promise<T>): Promise<T> {
    return asPrincipal(authFor(chairman), fn);
  }

  beforeAll(async () => {
    const slug = `it-servicedesk-tkt004-${stamp()}`;
    const seeded = await seedBootstrap({ tenantSlug: slug, tenantName: `Service desk IT-TKT-004 fixture ${slug}` });
    ttid = seeded.tenantId;

    const user = await unscopedPrisma.user.findFirstOrThrow({ where: { tenantId: ttid, email: 'chairman@kaizen.co.in' } });
    const affiliation = await unscopedPrisma.affiliation.findFirstOrThrow({
      where: { partyId: user.personId, tenantId: ttid, status: 'active' },
      orderBy: [{ primaryFlag: 'desc' }, { createdAt: 'asc' }],
    });
    chairman = {
      tenantId: ttid,
      partyId: user.personId,
      userId: user.id,
      affiliationId: affiliation.id,
      roleSlug: affiliation.roleSlug ?? 'chairman',
      branch: user.branch,
    };
  }, 60_000);

  it('never reports 100% with nothing behind it: a ticket resolved but backdated outside the current month does not count', async () => {
    const ticket = await asTenantChairman(() =>
      createTicket({ category: 'question', subject: `Attainment fixture ${stamp()}`, description: 'Resolved, but not this month.' }),
    );
    await asTenantChairman(() => triageTicket(ticket.id, { priority: 'P3' }));
    await asTenantChairman(() => assignTicket(ticket.id, chairman.partyId));
    await asTenantChairman(() => transitionTicket(ticket.id, 'START'));
    await asTenantChairman(() => transitionTicket(ticket.id, 'RESOLVE'));

    const lastMonth = new Date();
    lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
    await unscopedPrisma.itTicket.update({ where: { id: ticket.id }, data: { resolvedAt: lastMonth } });

    const s = await asTenantChairman(() => summary());
    // The ticket exists (triaged, resolved), so this is "no closed tickets
    // in the period", never the zero-tickets-ever branch.
    expect(s.notYetMeasured).toBe(false);
    expect(s.slaAttainment.response).toBeNull();
    expect(s.slaAttainment.resolution).toBeNull();

    // The zero-tickets-ever branch, exercised directly against the same
    // pure function the domain calls.
    expect(slaAttainment([])).toBeNull();
  });
});
