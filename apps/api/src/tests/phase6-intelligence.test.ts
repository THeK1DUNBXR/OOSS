import { describe, expect, it } from 'vitest';
import { AI_PROHIBITED_ACTIONS } from '@kaizen/shared';
import { compileMetricQuery, createMetricGraph } from '@kaizen/semantic';
import {
  ModelGateway,
  assertActionAllowed,
  createGateway,
  safeBriefingComposition,
} from '../platform/llm.js';

describe('Phase 6 intelligence foundations', () => {
  it('keeps autonomous journal, IRN, filing, payroll and email actions out of the model path', () => {
    expect(AI_PROHIBITED_ACTIONS).toEqual(
      expect.arrayContaining([
        'journal.post',
        'irn.generate',
        'filing.submit',
        'payroll.run',
        'email.send',
      ]),
    );

    expect(() => assertActionAllowed('journal.post')).toThrow(/prohibited|forbidden/i);
    expect(() => assertActionAllowed('payroll.run')).toThrow(/prohibited|forbidden/i);
    expect(() => assertActionAllowed('email.send')).toThrow(/prohibited|forbidden/i);
  });

  it('enforces the India-region policy and strips personal data before a model call', () => {
    const blockedGateway = createGateway({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      tenantId: 'tenant-1',
      tenantInferenceRegion: 'us',
      requireIndiaRegion: true,
    });

    expect(() => blockedGateway.assertTenantRegion()).toThrow(/India-region|tenant requires/i);

    const allowedGateway = createGateway({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      tenantId: 'tenant-1',
      tenantInferenceRegion: 'india',
      requireIndiaRegion: true,
    });

    const prepared = allowedGateway.preparePayload(
      'ask_kaizen',
      {
        fullName: 'Amit Sharma',
        email: 'amit@example.com',
        totalRevenue: 1_200_000,
      },
      'analytics.query',
    );

    expect(prepared.redacted.fullName).toBe('[redacted]');
    expect(prepared.redacted.email).toBe('[redacted]');
    expect(prepared.redactedFields).toEqual(expect.arrayContaining(['fullName', 'email']));
  });

  it('orchestrates Ask Kaizen and briefing work over typed semantic metrics', () => {
    const graph = createMetricGraph({
      entities: {
        sales: {
          table: 'sales_fact',
          tenantScoped: true,
          grain: 'invoice',
          dimensions: {
            month: { type: 'date' },
            region: { type: 'string' },
          },
        },
      },
      metrics: {
        revenue: {
          description: 'Total revenue',
          sql: 'SUM("amount")',
          source: 'sales',
          grain: 'invoice',
        },
      },
    });

    const gateway = new ModelGateway({
      provider: 'semantic',
      model: 'compiler',
      tenantId: 'tenant-1',
      tenantInferenceRegion: 'india',
      requireIndiaRegion: true,
    });

    const query = gateway.compileAskKaizenQuery(graph, {
      metrics: ['revenue'],
      dimensions: ['month'],
      filters: [{ field: 'region', value: 'Bengaluru' }],
      tenantId: 'tenant-1',
    });

    expect(query.sql).toContain('SUM("amount")');
    expect(query.sql).toContain('tenant_id');

    const briefing = safeBriefingComposition(
      graph,
      'tenant-1',
      [{ metric: 'revenue', dimensions: ['month'], filters: [{ field: 'region', value: 'Bengaluru' }] }],
      gateway,
    );

    expect(briefing.metrics).toEqual(['revenue']);
    expect(briefing.queries[0].sql).toContain('SUM("amount")');
  });
});
