import { describe, it, expect } from 'vitest';
import { asUser, prisma, tenantId } from '../helpers.js';
import { engagementEnps } from '../../domains/hcm/analytics.js';

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
      await prisma.surveyResponse.create({ data: { tenantId: TENANT, surveyId: survey.id, respondentToken: `tok-${stamp}-a`, answers: [{ questionId: 'q1', value: 9 }] } });
      const result = await engagementEnps();
      console.log('RESULT', JSON.stringify(result));
      expect(true).toBe(true);
    });
  });
});
