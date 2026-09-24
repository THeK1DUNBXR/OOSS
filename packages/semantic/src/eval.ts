import { compileMetricQuery, type CompileRequest, type CompiledQuery, SemanticCompileError } from './compiler.js';
import { createMetricGraph, type MetricGraph } from './graph.js';

export interface TenantSafeContext {
  tenantId: string;
  tenantColumn?: string;
  visibilityPredicate?: string | null;
  timeoutMs?: number;
}

export interface EvalCase {
  name: string;
  request: CompileRequest;
  expected: number;
}

export interface EvalResult {
  name: string;
  passed: boolean;
  expected: number;
  observed: number;
}

export function buildTenantSafeQuery(graph: MetricGraph, context: TenantSafeContext, request: Omit<CompileRequest, 'tenantId' | 'tenantColumn' | 'visibilityPredicate' | 'timeoutMs'>): CompiledQuery {
  const tenantSpecificRequest: CompileRequest = {
    ...request,
    tenantId: context.tenantId,
    tenantColumn: context.tenantColumn ?? 'tenant_id',
    visibilityPredicate: context.visibilityPredicate ?? null,
    timeoutMs: context.timeoutMs ?? 5_000,
  };

  return compileMetricQuery(graph, tenantSpecificRequest);
}

export function assertTenantScoped(graph: MetricGraph, tenantId: string, request: CompileRequest): void {
  const compiled = compileMetricQuery(graph, { ...request, tenantId });
  if (!compiled.sql.includes(`"${compiled.tenantColumn}"`)) {
    throw new SemanticCompileError(`Compiled query is not tenant-scoped on ${compiled.tenantColumn}.`);
  }
  if (!compiled.sql.includes(`= :tenantId`)) {
    throw new SemanticCompileError('The compiler did not inject the tenant guard.');
  }
}

export function runGoldenEval(graph: MetricGraph, cases: EvalCase[], runner: (query: CompiledQuery) => number): EvalResult[] {
  return cases.map(({ name, request, expected }) => {
    const compiled = compileMetricQuery(graph, request);
    const observed = runner(compiled);
    return {
      name,
      passed: observed === expected,
      expected,
      observed,
    };
  });
}

export function defaultSemanticGraph(): MetricGraph {
  const baseGraph = createMetricGraph({
    entities: {
      invoice: {
        table: 'invoices',
        tenantScoped: true,
        grain: 'invoice',
        joins: {
          customer: { kind: 'belongsTo', target: 'party', cardinality: 'one', path: 'customer_id' },
          lines: { kind: 'hasMany', target: 'invoice_line', cardinality: 'many', path: 'invoice_id' },
        },
        dimensions: {
          issued_date: { type: 'date', ist: true },
          status: { type: 'enum', values: ['draft', 'posted', 'paid', 'cancelled'] },
          place_of_supply: { type: 'string' },
        },
      },
      invoice_line: {
        table: 'invoice_lines',
        tenantScoped: true,
        grain: 'invoice_line',
        dimensions: {
          amount_minor: { type: 'number' },
          tax_amount_minor: { type: 'number' },
        },
      },
      party: {
        table: 'parties',
        tenantScoped: true,
        grain: 'party',
        dimensions: {
          name: { type: 'string' },
        },
      },
      journal_line: {
        table: 'journal_lines',
        tenantScoped: true,
        grain: 'journal_line',
        dimensions: {
          issued_date: { type: 'date', ist: true },
          account_type: { type: 'string' },
          base_amount_minor: { type: 'number' },
        },
      },
    },
    metrics: {
      revenue: {
        description: 'Recognised revenue net of credit notes excluding tax.',
        sql: 'SUM(base_amount_minor)',
        source: 'journal_line',
        grain: 'journal_line',
        synonyms: ['sales', 'turnover', 'top line'],
        requires: { resource: 'finance', verb: 'view' },
      },
      invoice_count: {
        description: 'Count of invoices in the requested slice.',
        sql: 'COUNT(*)',
        source: 'invoice',
        grain: 'invoice',
        synonyms: ['invoices'],
        requires: { resource: 'finance', verb: 'view' },
      },
    },
  });

  return baseGraph;
}
