import { compileMetricQuery, type CompileRequest } from '../compiler.js';
import { defaultSemanticGraph } from '../eval.js';

export interface GoldenCase {
  name: string;
  request: CompileRequest;
  expected: number;
  notes?: string;
}

export const semanticGoldenCases: GoldenCase[] = [
  {
    name: 'revenue current month',
    request: {
      metrics: ['revenue'],
      dimensions: ['issued_date'],
      tenantId: 'tenant-42',
      visibilityPredicate: 'base."tenant_id" = :tenantId',
    },
    expected: 4200,
    notes: 'Exact numeric result expected for the seeded fixture used by the semantic evaluator.',
  },
  {
    name: 'invoice count status slice',
    request: {
      metrics: ['invoice_count'],
      dimensions: ['status'],
      tenantId: 'tenant-42',
      filters: [{ field: 'status', operator: '=', value: 'posted' }],
    },
    expected: 3,
    notes: 'A deterministic status filter should yield an exact count without fan-out multiplication.',
  },
];

export function goldenSqlPreview(): string[] {
  const graph = defaultSemanticGraph();
  return semanticGoldenCases.map((entry) => compileMetricQuery(graph, entry.request).sql);
}
