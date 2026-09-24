import {
  AI_PROHIBITED_ACTIONS,
  FIELD_PURPOSES,
  applyFieldVisibility,
  type SensitivityClass,
} from '@kaizen/shared';
import {
  compileMetricQuery,
  type CompileRequest,
  type CompiledQuery,
  type MetricFilter,
  type MetricGraph,
} from '@kaizen/semantic';

export type LlmRegion = 'india' | 'us' | 'eu' | 'global' | 'local';
export type LlmTask = 'briefing' | 'ask_kaizen' | 'drafting' | 'extraction' | 'forecasting';
export type ApprovalClassification = 'read_only' | 'reversible_single_record' | 'irreversible_external';

const PERSONAL_DATA_FIELDS = new Set([
  'fullName',
  'email',
  'phone',
  'dateOfBirth',
  'panNumber',
  'aadhaarReference',
  'bankAccountNumber',
  'bankAccountName',
  'bankIfsc',
  'guardianName',
  'guardianPhone',
  'guardianConsentId',
]);

const PROHIBITED_ACTION_PREFIXES = ['journal.', 'journal_entry.', 'irn.', 'filing.', 'payroll.', 'email.'];

export interface ModelGatewayConfig {
  provider: string;
  model: string;
  tenantId: string;
  tenantInferenceRegion?: LlmRegion;
  requireIndiaRegion?: boolean;
  canSeeMoney?: boolean;
  fieldClassifications?: Record<string, SensitivityClass>;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxSteps?: number;
  hardSpendCap?: number;
  timeoutMs?: number;
}

export interface ModelGatewayCall<TPayload extends Record<string, unknown>> {
  task: LlmTask;
  action?: string;
  payload: TPayload;
  correlationId: string;
}

export interface ModelGatewayResult<TPayload extends Record<string, unknown>> {
  redacted: TPayload;
  correlationId: string;
  region: LlmRegion;
  actionRequired: boolean;
  prohibited: boolean;
  redactedFields: string[];
}

export interface BriefingMetricSpec {
  metric: string;
  dimensions?: string[];
  filters?: MetricFilter[];
}

export function normalizeAction(action: string): string {
  return action.trim().toLowerCase();
}

export function classifyAction(action?: string): ApprovalClassification {
  if (!action) return 'read_only';
  const normalized = normalizeAction(action);
  if (normalized.includes('journal') || normalized.includes('irn') || normalized.includes('filing')) {
    return 'irreversible_external';
  }
  if (normalized.includes('email') || normalized.includes('payroll')) {
    return 'irreversible_external';
  }
  if (normalized.includes('draft') || normalized.includes('recommend') || normalized.includes('suggest')) {
    return 'reversible_single_record';
  }
  return 'read_only';
}

export function assertActionAllowed(action?: string): void {
  if (!action) return;
  const normalized = normalizeAction(action);
  if (AI_PROHIBITED_ACTIONS.includes(normalized)) {
    throw new Error(`AI action '${action}' is prohibited and cannot be executed without human approval.`);
  }
  if (PROHIBITED_ACTION_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    throw new Error(`AI action '${action}' is a forbidden irreversible or external action.`);
  }
}

export function isIndiaRegionRequired(config: Pick<ModelGatewayConfig, 'tenantInferenceRegion' | 'requireIndiaRegion'>): boolean {
  return config.requireIndiaRegion === true || config.tenantInferenceRegion === 'india';
}

export function allowInferenceRegion(
  region: LlmRegion | undefined,
  config: Pick<ModelGatewayConfig, 'tenantInferenceRegion' | 'requireIndiaRegion'>,
): boolean {
  if (!region) return true;
  if (isIndiaRegionRequired(config)) {
    return region === 'india' || region === 'local';
  }
  return true;
}

export function redactPersonalFields<T extends Record<string, unknown>>(payload: T): { data: T; redactedFields: string[] } {
  const seen: string[] = [];
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map((item) => walk(item));
    if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (PERSONAL_DATA_FIELDS.has(key)) {
          seen.push(key);
          out[key] = '[redacted]';
          continue;
        }
        out[key] = walk(child);
      }
      return out;
    }
    return value;
  };

  const redacted = walk(payload) as T;
  return { data: redacted, redactedFields: [...new Set(seen)] };
}

export function sanitizeForModel<T extends Record<string, unknown>>(
  payload: T,
  config: Pick<ModelGatewayConfig, 'canSeeMoney' | 'fieldClassifications'>,
): { data: T; redactedFields: string[] } {
  const fieldClassifications = config.fieldClassifications ?? {};
  const withholdPaths: Array<{ path: string; reason: 'classification_ceiling' | 'no_permission' }> = [];
  const result = applyFieldVisibility(payload, {
    canSeeMoney: config.canSeeMoney ?? false,
    ceiling: 'restricted',
    fieldClassifications,
    fieldPurposes: FIELD_PURPOSES,
    withholdPaths,
  });

  const redactedFields = result.withheld.map((entry) => entry.path);
  return { data: result.data as T, redactedFields };
}

export class ModelGateway {
  public readonly config: ModelGatewayConfig;

  constructor(config: ModelGatewayConfig) {
    this.config = {
      ...config,
      tenantInferenceRegion: config.tenantInferenceRegion ?? 'global',
      canSeeMoney: config.canSeeMoney ?? false,
      maxInputTokens: config.maxInputTokens ?? 32_000,
      maxOutputTokens: config.maxOutputTokens ?? 8_000,
      maxSteps: config.maxSteps ?? 8,
      hardSpendCap: config.hardSpendCap ?? 25_000,
      timeoutMs: config.timeoutMs ?? 15_000,
    };
  }

  public providerName(): string {
    return `${this.config.provider}/${this.config.model}`;
  }

  public getEffectiveRegion(): LlmRegion {
    return this.config.tenantInferenceRegion ?? 'global';
  }

  public assertTenantRegion(): void {
    if (!allowInferenceRegion(this.getEffectiveRegion(), this.config)) {
      throw new Error(
        `Tenant requires India-region inference policy, but the gateway is configured for ${this.getEffectiveRegion()}.`,
      );
    }
  }

  public preparePayload<T extends Record<string, unknown>>(
    task: LlmTask,
    payload: T,
    action?: string,
  ): ModelGatewayResult<T> {
    if (action) {
      assertActionAllowed(action);
    }
    this.assertTenantRegion();

    const filtered = sanitizeForModel(payload, {
      canSeeMoney: this.config.canSeeMoney ?? false,
      fieldClassifications: this.config.fieldClassifications,
    });

    const redactedResult = redactPersonalFields(filtered.data as T);
    return {
      redacted: redactedResult.data,
      correlationId: `llm-${task}-${Date.now()}`,
      region: this.getEffectiveRegion(),
      actionRequired: action !== undefined && classifyAction(action) !== 'read_only',
      prohibited:
        action !== undefined &&
        (AI_PROHIBITED_ACTIONS.includes(normalizeAction(action)) ||
          PROHIBITED_ACTION_PREFIXES.some((prefix) => normalizeAction(action).startsWith(prefix))),
      redactedFields: [...new Set([...filtered.redactedFields, ...redactedResult.redactedFields])],
    };
  }

  public async call<T extends Record<string, unknown>>(request: ModelGatewayCall<T>): Promise<ModelGatewayResult<T>> {
    if (request.task === 'ask_kaizen') {
      return this.preparePayload(request.task, request.payload, request.action ?? 'analytics.query');
    }

    if (request.task === 'briefing') {
      return this.preparePayload(request.task, request.payload, request.action ?? 'read_only_summary');
    }

    return this.preparePayload(request.task, request.payload, request.action);
  }

  public compileAskKaizenQuery(graph: MetricGraph, request: CompileRequest): CompiledQuery {
    return compileMetricQuery(graph, request);
  }

  public buildBriefingQueries(graph: MetricGraph, tenantId: string, metrics: BriefingMetricSpec[]): CompiledQuery[] {
    return metrics.map((metric) =>
      this.compileAskKaizenQuery(graph, {
        tenantId,
        metrics: [metric.metric],
        dimensions: metric.dimensions ?? [],
        filters: metric.filters ?? [],
      }),
    );
  }
}

export function createGateway(config: ModelGatewayConfig): ModelGateway {
  return new ModelGateway(config);
}

export function safeBriefingComposition(
  graph: MetricGraph,
  tenantId: string,
  metrics: BriefingMetricSpec[],
  gateway: ModelGateway,
): { metrics: string[]; queries: CompiledQuery[] } {
  const compiled = gateway.buildBriefingQueries(graph, tenantId, metrics);
  return {
    metrics: metrics.map((entry) => entry.metric),
    queries: compiled,
  };
}

export function assertAllowedSemanticQuery(graph: MetricGraph, request: CompileRequest): CompiledQuery {
  const gateway = createGateway({
    provider: 'semantic',
    model: 'compiler',
    tenantId: request.tenantId,
    tenantInferenceRegion: 'india',
    requireIndiaRegion: true,
  });
  return gateway.compileAskKaizenQuery(graph, request);
}
