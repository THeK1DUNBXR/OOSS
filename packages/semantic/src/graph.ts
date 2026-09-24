export type JoinKind = 'belongsTo' | 'hasMany' | 'hasOne';
export type Grain = 'invoice' | 'journal_line' | 'customer' | 'party' | 'invoice_line' | 'row' | string;
export type DimensionType = 'string' | 'number' | 'date' | 'enum';

export interface DimensionDefinition {
  type: DimensionType;
  ist?: boolean;
  values?: readonly string[];
}

export interface JoinDefinition {
  kind: JoinKind;
  target: string;
  cardinality: 'one' | 'many';
  path?: string;
}

export interface EntityDefinition {
  table: string;
  tenantScoped: boolean;
  grain: Grain;
  joins?: Record<string, JoinDefinition>;
  dimensions?: Record<string, DimensionDefinition>;
}

export interface MetricDefinition {
  description: string;
  sql: string;
  source: string;
  grain: Grain;
  synonyms?: string[];
  requires?: {
    resource: string;
    verb: string;
  };
}

export interface MetricGraph {
  entities: Record<string, EntityDefinition>;
  metrics: Record<string, MetricDefinition>;
}

export function defineEntity(name: string, definition: EntityDefinition): { name: string; definition: EntityDefinition } {
  return { name, definition };
}

export function defineMetric(name: string, definition: MetricDefinition): { name: string; definition: MetricDefinition } {
  return { name, definition };
}

export function createMetricGraph(graph: Partial<MetricGraph> = {}): MetricGraph {
  return {
    entities: graph.entities ?? {},
    metrics: graph.metrics ?? {},
  };
}

export function registerEntity(graph: MetricGraph, name: string, definition: EntityDefinition): MetricGraph {
  return {
    ...graph,
    entities: {
      ...graph.entities,
      [name]: definition,
    },
  };
}

export function registerMetric(graph: MetricGraph, name: string, definition: MetricDefinition): MetricGraph {
  return {
    ...graph,
    metrics: {
      ...graph.metrics,
      [name]: definition,
    },
  };
}

export function getEntity(graph: MetricGraph, name: string): EntityDefinition | undefined {
  return graph.entities[name];
}

export function getMetric(graph: MetricGraph, name: string): MetricDefinition | undefined {
  return graph.metrics[name];
}
