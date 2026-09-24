import { getEntity, getMetric, type MetricGraph } from './graph.js';

export type FilterOperator = '=' | '!=' | '>' | '>=' | '<' | '<=' | 'in' | 'not_in';

export interface MetricFilter {
  field: string;
  operator?: FilterOperator;
  value: string | number | boolean | null | Array<string | number | boolean | null>;
}

export interface CompiledQuery {
  sql: string;
  bindings: Record<string, unknown>;
  metrics: string[];
  dimensions: string[];
  sourceTable: string;
  tenantColumn: string;
  readOnly: boolean;
  timeoutMs: number;
  permissionGuard: string | null;
}

export interface CompileRequest {
  metrics: string[];
  dimensions?: string[];
  filters?: MetricFilter[];
  tenantId: string;
  tenantColumn?: string;
  visibilityPredicate?: string | null;
  timeGrain?: 'day' | 'month' | 'year';
  comparison?: 'none' | 'previous_period';
  timeoutMs?: number;
}

export class SemanticCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SemanticCompileError';
  }
}

export function compileMetricQuery(graph: MetricGraph, request: CompileRequest): CompiledQuery {
  if (request.metrics.length === 0) {
    throw new SemanticCompileError('At least one metric is required.');
  }

  const tenantColumn = request.tenantColumn ?? 'tenant_id';
  const timeoutMs = request.timeoutMs ?? 5_000;
  const metrics = request.metrics.map((name) => {
    const metric = getMetric(graph, name);
    if (!metric) {
      throw new SemanticCompileError(`Unknown metric: ${name}`);
    }
    return metric;
  });

  const metricSource = metrics[0]?.source;
  if (!metricSource) {
    throw new SemanticCompileError('Metric source is required.');
  }

  const sourceEntity = getEntity(graph, metricSource);
  if (!sourceEntity) {
    throw new SemanticCompileError(`Unknown metric source entity: ${metricSource}`);
  }

  const dimensions = request.dimensions ?? [];
  const filterList = request.filters ?? [];

  const invalidMetric = metrics.find((metric) => metric.source !== metricSource);
  if (invalidMetric) {
    throw new SemanticCompileError(
      `Cross-source metrics are not compilable without a shared grain: ${metricSource} vs ${invalidMetric.source}`,
    );
  }

  for (const dimension of dimensions) {
    validateDimensionPath(sourceEntity, metricSource, dimension);
  }

  for (const filter of filterList) {
    validateDimensionPath(sourceEntity, metricSource, filter.field);
  }

  const selectFields = dimensions.length > 0 ? dimensions.map((dimension) => `base.${quoteIdentifier(dimension)}`) : [];
  const selectMetrics = metrics.map((metric) => `${metric.sql} AS ${quoteIdentifier(metricKey(metric))}`);
  const selectedSql = [...selectFields, ...selectMetrics].join(', ');

  const whereClauses: string[] = [`base.${quoteIdentifier(tenantColumn)} = :tenantId`];
  const bindings: Record<string, unknown> = { tenantId: request.tenantId };

  for (const filter of filterList) {
    const clause = buildFilterClause(filter, bindings, 'base');
    whereClauses.push(clause);
  }

  if (request.visibilityPredicate) {
    whereClauses.push(`(${request.visibilityPredicate})`);
  }

  const groupBy = dimensions.length > 0 ? ` GROUP BY ${dimensions.map((dimension) => `base.${quoteIdentifier(dimension)}`).join(', ')}` : '';
  const sql = `SELECT ${selectedSql} FROM ${quoteIdentifier(sourceEntity.table)} AS base WHERE ${whereClauses.join(' AND ')}${groupBy};`;

  return {
    sql,
    bindings,
    metrics: request.metrics,
    dimensions,
    sourceTable: sourceEntity.table,
    tenantColumn,
    readOnly: true,
    timeoutMs,
    permissionGuard: request.visibilityPredicate ?? null,
  };
}

export function buildFilterClause(filter: MetricFilter, bindings: Record<string, unknown>, tableAlias = 'base'): string {
  const field = `${tableAlias}.${quoteIdentifier(filter.field)}`;
  const paramName = `${sanitizeBinding(filter.field)}_${Object.keys(bindings).length}`;

  if (filter.operator === 'in' || filter.operator === 'not_in') {
    const values = Array.isArray(filter.value) ? filter.value : [filter.value];
    const placeholders = values.map((value, index) => {
      const key = `${paramName}_${index}`;
      bindings[key] = value;
      return `:${key}`;
    });
    const operator = filter.operator === 'in' ? 'IN' : 'NOT IN';
    return `${field} ${operator} (${placeholders.join(', ')})`;
  }

  bindings[paramName] = filter.value;
  const operator = filter.operator ?? '=';
  return `${field} ${operator} :${paramName}`;
}

export function withTenantScope(query: string, tenantId: string, tenantColumn = 'tenant_id', visibilityPredicate?: string | null): string {
  const clauses = [`${quoteIdentifier(tenantColumn)} = ${sqlLiteral(tenantId)}`];
  if (visibilityPredicate) {
    clauses.push(`(${visibilityPredicate})`);
  }
  return `${query} AND ${clauses.join(' AND ')}`;
}

export function makeReadOnlyGuard(timeoutMs: number): string {
  return `SET LOCAL statement_timeout = '${timeoutMs}ms';`;
}

export function explainMetricGraph(graph: MetricGraph): Record<string, { source: string; grain: string; requires: string | null }> {
  return Object.fromEntries(
    Object.entries(graph.metrics).map(([name, metric]) => [
      name,
      {
        source: metric.source,
        grain: metric.grain,
        requires: metric.requires ? `${metric.requires.resource}:${metric.requires.verb}` : null,
      },
    ]),
  );
}

function validateDimensionPath(sourceEntity: { dimensions?: Record<string, unknown>; joins?: Record<string, { kind: string; target: string; cardinality: 'one' | 'many'; path?: string }> }, metricSource: string, field: string): void {
  if (field === 'tenant_id') return;

  if (!field.includes('.')) {
    if (!sourceEntity.dimensions?.[field] && !field.startsWith('date_')) {
      throw new SemanticCompileError(`Dimension ${field} is not defined on ${metricSource}.`);
    }
    return;
  }

  const [joinName, leafName] = field.split('.');
  const join = sourceEntity.joins?.[joinName];
  if (!join) {
    throw new SemanticCompileError(`Join ${joinName} is not defined on ${metricSource}.`);
  }
  if (join.cardinality === 'many') {
    throw new SemanticCompileError(`The join ${joinName} would fan out and is not compilable in ${metricSource}.`);
  }
  if (leafName && !sourceEntity.dimensions?.[leafName]) {
    throw new SemanticCompileError(`Dimension ${field} is not defined on ${metricSource}.`);
  }
}

function metricKey(metric: { sql: string; source: string }): string {
  return `${metric.source}_${metric.sql.replace(/[^a-zA-Z0-9]+/g, '_')}`.replace(/^_+|_+$/g, '');
}

function sanitizeBinding(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, '_');
}

function sqlLiteral(value: string | number | boolean | null): string {
  if (value === null) return 'NULL';
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return String(value);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}
