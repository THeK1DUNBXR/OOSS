/**
 * HCM — WS9 engagement (docs/hcm/engagement.md).
 *
 * HCM-ENGAGEMENT-001..010: announcements and acknowledgement, recognition and
 * its self-recognition refusal, pulse surveys (including the anonymous
 * no-double-submit rule and eNPS aggregation), the HR helpdesk queue with its
 * confidential-grievance concealment (the POSH pattern from
 * compliance/labour.ts, applied here), policy acknowledgement, and the
 * /me/home aggregate.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { computeEnps, isHrCaseSlaBreached } from '@kaizen/shared';
import { asUser, prisma, tenantId, unscopedPrisma } from '../helpers.js';
import {
  createAnnouncement,
  listAnnouncements,
  acknowledgeAnnouncement,
  announcementAcks,
  giveRecognition,
  listRecognitions,
  recognitionLeaderboard,
  createPulseSurvey,
  submitSurveyResponse,
  pulseSurveyResults,
  createHrCase,
  listHrCases,
  listConfidentialHrCases,
  getHrCase,
  transitionHrCase,
  createPolicyDocument,
  acknowledgePolicyDocument,
  policyAckStatus,
  myEngagementHome,
} from '../../domains/hcm/engagement.js';

let TENANT: string;

beforeAll(async () => {
  TENANT = await tenantId();
});

function stamp(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

describe('Pure logic', () => {
  it('HCM-ENGAGEMENT-001: eNPS classifies 9-10 as promoters and 0-6 as detractors, and scores accordingly', () => {
    const result = computeEnps([10, 9, 8, 7, 6, 5, 0]);
    expect(result.promoters).toBe(2);
    expect(result.passives).toBe(2);
    expect(result.detractors).toBe(3);
    // (2 - 3) / 7 * 100 = -14.28.. -> rounds to -14
    expect(result.score).toBe(-14);
  });

  it('HCM-ENGAGEMENT-002: an HR case is SLA-breached only while it is still open past its due date', () => {
    const due = new Date(Date.now() - 3_600_000);
    expect(isHrCaseSlaBreached('open', due)).toBe(true);
    expect(isHrCaseSlaBreached('resolved', due)).toBe(false);
    expect(isHrCaseSlaBreached('open', new Date(Date.now() + 3_600_000))).toBe(false);
  });
});

describe('Announcements', () => {
  it('HCM-ENGAGEMENT-003: HR ops publishes an announcement, and it reaches an employee\'s feed and pending-ack list', async () => {
    const title = `Fixture announcement ${stamp()}`;
    const created = await asUser('operations@kaizen.co.in', () =>
      createAnnouncement({ title, body: 'All hands on Friday.', acknowledgementRequired: true, publishNow: true }),
    );
    expect(created.status).toBe('published');
    expect(created.recordCode).toMatch(/^ANN-\d{4}-\d{5}$/);

    const feed = await asUser('employee@kaizen.co.in', () => listAnnouncements());
    expect(feed.some((a) => a.id === created.id)).toBe(true);

    const home = await asUser('employee@kaizen.co.in', () => myEngagementHome());
    expect(home.pendingAcknowledgements.announcements.some((a) => a.id === created.id)).toBe(true);

    await asUser('employee@kaizen.co.in', () => acknowledgeAnnouncement(created.id));
    const homeAfter = await asUser('employee@kaizen.co.in', () => myEngagementHome());
    expect(homeAfter.pendingAcknowledgements.announcements.some((a) => a.id === created.id)).toBe(false);

    const acks = await asUser('operations@kaizen.co.in', () => announcementAcks(created.id));
    expect(acks.ackCount).toBeGreaterThanOrEqual(1);
  });

  it('HCM-ENGAGEMENT-004: an employee cannot publish an announcement — creating one is refused at the grant', async () => {
    await expect(
      asUser('employee@kaizen.co.in', () => createAnnouncement({ title: 'Should not land', body: 'x', publishNow: true })),
    ).rejects.toThrow();
  });

  it('HCM-ENGAGEMENT-005: a draft (unpublished, future-dated) announcement never appears in an employee\'s feed', async () => {
    const created = await asUser('operations@kaizen.co.in', () =>
      createAnnouncement({
        title: `Fixture future ${stamp()}`,
        body: 'Not yet.',
        publishAt: new Date(Date.now() + 30 * 86_400_000),
        publishNow: false,
      }),
    );
    expect(created.status).toBe('draft');
    const feed = await asUser('employee@kaizen.co.in', () => listAnnouncements());
    expect(feed.some((a) => a.id === created.id)).toBe(false);
  });
});

describe('Recognition', () => {
  it('HCM-ENGAGEMENT-006: an employee can give and receive recognition, but never give it to themselves', async () => {
    const ravi = await asUser('ravi@kaizen.co.in', async (p) => p);
    const recognition = await asUser('divya@kaizen.co.in', () =>
      giveRecognition({ toPartyId: ravi.partyId, badge: 'Team player', message: 'Great sprint help.', points: 10 }),
    );
    expect(recognition.recordCode).toMatch(/^REC-\d{4}-\d{5}$/);

    const raviView = await asUser('ravi@kaizen.co.in', () => listRecognitions());
    expect(raviView.some((r) => r.id === recognition.id)).toBe(true);

    await expect(
      asUser('divya@kaizen.co.in', async (p) => giveRecognition({ toPartyId: p.partyId, badge: 'Self five', message: 'x' })),
    ).rejects.toThrow();
  });

  it('HCM-ENGAGEMENT-007: the recognition leaderboard is an all-scope aggregate an ordinary employee cannot pull', async () => {
    await expect(asUser('ravi@kaizen.co.in', () => recognitionLeaderboard())).rejects.toThrow();
    const board = await asUser('operations@kaizen.co.in', () => recognitionLeaderboard());
    expect(Array.isArray(board)).toBe(true);
  });

  it('HCM-ENGAGEMENT-008: an employee only ever sees recognitions they gave or received, never a colleague\'s', async () => {
    const priya = await asUser('priya@kaizen.co.in', async (p) => p);
    const kavitha = await asUser('kavitha@kaizen.co.in', async (p) => p);
    await asUser('priya@kaizen.co.in', () =>
      giveRecognition({ toPartyId: kavitha.partyId, badge: 'Delivery win', message: 'Shipped on time.' }),
    );
    const ravisView = await asUser('ravi@kaizen.co.in', () => listRecognitions());
    const priyaToKavitha = ravisView.find((r) => r.badge === 'Delivery win' && r.toPartyId === kavitha.partyId);
    expect(priyaToKavitha).toBeUndefined();
  });
});

describe('Pulse surveys — anonymity and eNPS', () => {
  it('HCM-ENGAGEMENT-009: an anonymous survey accepts one response per employee and reports only aggregates', async () => {
    const survey = await asUser('operations@kaizen.co.in', () =>
      createPulseSurvey({
        title: `Fixture pulse ${stamp()}`,
        anonymous: true,
        questions: [{ id: 'q1', type: 'enps', text: 'How likely to recommend?' }],
        opensAt: new Date(Date.now() - 1000),
        closesAt: new Date(Date.now() + 7 * 86_400_000),
      }),
    );
    expect(survey.status).toBe('open');

    await asUser('ravi@kaizen.co.in', () => submitSurveyResponse(survey.id, 'unused', [{ questionId: 'q1', value: 9 }]));
    await expect(
      asUser('ravi@kaizen.co.in', () => submitSurveyResponse(survey.id, 'unused', [{ questionId: 'q1', value: 3 }])),
    ).rejects.toThrow();

    await asUser('divya@kaizen.co.in', () => submitSurveyResponse(survey.id, 'unused', [{ questionId: 'q1', value: 3 }]));

    const results = await asUser('operations@kaizen.co.in', () => pulseSurveyResults(survey.id));
    expect(results.totalResponses).toBe(2);
    const q1 = results.questions[0] as { promoters: number; detractors: number };
    expect(q1.promoters).toBe(1);
    expect(q1.detractors).toBe(1);
    // No response row exposes who answered what.
    const rows = await asUser('operations@kaizen.co.in', () =>
      prisma.surveyResponse.findMany({ where: { tenantId: TENANT, surveyId: survey.id } }),
    );
    expect(rows.every((r) => r.employmentRelationshipId === null)).toBe(true);
  });
});

describe('HR helpdesk — confidential-grievance concealment', () => {
  it('HCM-ENGAGEMENT-010: a grievance is auto-confidential, absent from the general queue, and reachable only through the dedicated confidential listing', async () => {
    const grievance = await asUser('ravi@kaizen.co.in', () =>
      createHrCase({ category: 'grievance', subject: 'Fixture grievance', body: 'A concern I need to raise.' }),
    );
    expect(grievance.confidential).toBe(true);
    expect(grievance.recordCode).toMatch(/^CASE-\d{4}-\d{5}$/);

    const hrQueue = await asUser('operations@kaizen.co.in', () => listHrCases());
    expect(hrQueue.some((c) => c.id === grievance.id)).toBe(false);

    const confidentialQueue = await asUser('operations@kaizen.co.in', () => listConfidentialHrCases());
    expect(confidentialQueue.some((c) => c.id === grievance.id)).toBe(true);

    // An unrelated employee cannot even see that the case exists.
    await expect(asUser('divya@kaizen.co.in', () => getHrCase(grievance.id))).rejects.toThrow();

    // Finance holds no hr_cases grant at all and gets a plain 403 on the confidential listing.
    await expect(asUser('finance@kaizen.co.in', () => listConfidentialHrCases())).rejects.toThrow();

    // The raiser can still read and act on their own case.
    const mine = await asUser('ravi@kaizen.co.in', () => getHrCase(grievance.id));
    expect(mine.case.id).toBe(grievance.id);
  });

  it('HCM-ENGAGEMENT-011: a non-grievance case is visible in the general queue and follows its status transitions', async () => {
    const payrollCase = await asUser('divya@kaizen.co.in', () =>
      createHrCase({ category: 'payroll', subject: 'Fixture payroll query', body: 'My payslip looks off.' }),
    );
    expect(payrollCase.confidential).toBe(false);

    const hrQueue = await asUser('operations@kaizen.co.in', () => listHrCases());
    expect(hrQueue.some((c) => c.id === payrollCase.id)).toBe(true);

    const resolved = await asUser('operations@kaizen.co.in', () => transitionHrCase(payrollCase.id, 'resolved', 'Fixed the input.'));
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolvedAt).not.toBeNull();

    await expect(asUser('operations@kaizen.co.in', () => transitionHrCase(payrollCase.id, 'not-a-status' as never))).rejects.toThrow();
  });

  it('HCM-ENGAGEMENT-012: an employee cannot reach a colleague\'s open case by id, cross-tenant reach included', async () => {
    const raviCase = await asUser('ravi@kaizen.co.in', () =>
      createHrCase({ category: 'it', subject: 'Fixture IT case', body: 'Laptop will not boot.' }),
    );
    await expect(asUser('priya@kaizen.co.in', () => getHrCase(raviCase.id))).rejects.toThrow();

    // Same id, wrong tenant — never found, never a cross-tenant leak.
    const otherTenant = await unscopedPrisma.tenant.findFirst({ where: { NOT: { id: TENANT } } });
    if (otherTenant) {
      const foreign = await unscopedPrisma.hrCase.findFirst({ where: { tenantId: otherTenant.id } });
      if (foreign) {
        await expect(asUser('operations@kaizen.co.in', () => getHrCase(foreign.id))).rejects.toThrow();
      }
    }
  });
});

describe('Policy acknowledgement', () => {
  it('HCM-ENGAGEMENT-013: a published policy needing acknowledgement tracks who has and has not acked it', async () => {
    const policy = await asUser('operations@kaizen.co.in', () =>
      createPolicyDocument({
        title: `Fixture code of conduct ${stamp()}`,
        version: '1.0',
        body: 'Be excellent to each other.',
        effectiveFrom: new Date(),
        acknowledgementRequired: true,
      }),
    );
    expect(policy.status).toBe('published');

    const before = await asUser('operations@kaizen.co.in', () => policyAckStatus(policy.id));
    expect(before.ackCount).toBe(0);

    await asUser('ravi@kaizen.co.in', () => acknowledgePolicyDocument(policy.id));
    const after = await asUser('operations@kaizen.co.in', () => policyAckStatus(policy.id));
    expect(after.ackCount).toBe(1);

    // An ordinary employee cannot pull the aggregate ack-status themselves.
    await expect(asUser('ravi@kaizen.co.in', () => policyAckStatus(policy.id))).rejects.toThrow();
  });
});
