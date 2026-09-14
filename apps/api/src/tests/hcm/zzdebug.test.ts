import { describe, it, expect } from 'vitest';
import { asUser, prisma, tenantId } from '../helpers.js';

describe('debug', () => {
  it('debug enps', async () => {
    const TENANT = await tenantId();
    const stamp = `${Date.now()}`;
    await asUser('operations@kaizen.co.in', async () => {
      const survey = await prisma.pulseSurvey.create({
        data: {
          tenantId: TENANT,
          recordCode: `SVY-TEST-${stamp}`,
          title: `Fixture pulse ${stamp}`,
          questions: [{ id: 'q1', type: 'enps', text: 'x' }],
          anonymous: true,
          opensAt: new Date(Date.now() - 86400000),
          closesAt: new Date(Date.now() + 86400000),
          status: 'open',
        },
      });
      const found = await (prisma as any).pulseSurvey.findMany({ where: { tenantId: TENANT }, select: { id: true, questions: true } });
      console.log('SURVEYS', JSON.stringify(found));
      const resp = await prisma.surveyResponse.create({ data: { tenantId: TENANT, surveyId: survey.id, respondentToken: `tok-${stamp}-a`, answers: [{ questionId: 'q1', value: 9 }] } });
      const foundResp = await (prisma as any).surveyResponse.findMany({ where: { tenantId: TENANT, surveyId: { in: [survey.id] } }, select: { surveyId: true, answers: true } });
      console.log('RESPONSES', JSON.stringify(foundResp));
      expect(true).toBe(true);
    });
  });
});
