/**
 * Tenant policy helpers for product gating and data-residency enforcement.
 *
 * The decision is always read from the tenant's existing `config` JSON, with a
 * tier fallback. This keeps the rules tenant-safe without creating a parallel
 * product table or a shadow copy of the runtime state.
 */

import {
  GLOBAL_INFERENCE_REGIONS,
  INDIA_INFERENCE_REGIONS,
  TENANT_FEATURES,
  TENANT_TIERS,
  type InferenceRegion,
  type TenantConfig,
  type TenantFeature,
  type TenantTier,
} from '@kaizen/shared';

export const DEFAULT_TENANT_TIER: TenantTier = 'starter';

const DEFAULT_TENANT_FEATURE_GATES: Record<TenantTier, Partial<Record<TenantFeature, boolean>>> = {
  starter: {
    invoicing: true,
    payroll: false,
    statutory: true,
    analytics: false,
    ai: false,
    india_residency: true,
    database_per_tenant: false,
    byok: false,
    irn_sandbox: true,
  },
  growth: {
    invoicing: true,
    payroll: true,
    statutory: true,
    analytics: true,
    ai: false,
    india_residency: true,
    database_per_tenant: false,
    byok: false,
    irn_sandbox: true,
  },
  enterprise: {
    invoicing: true,
    payroll: true,
    statutory: true,
    analytics: true,
    ai: true,
    india_residency: true,
    database_per_tenant: true,
    byok: true,
    irn_sandbox: true,
  },
  sovereign: {
    invoicing: true,
    payroll: true,
    statutory: true,
    analytics: true,
    ai: true,
    india_residency: true,
    database_per_tenant: true,
    byok: true,
    irn_sandbox: true,
  },
};

export function resolveTenantTier(config: Partial<TenantConfig> | null | undefined): TenantTier {
  const override = config?.tier;
  return override && TENANT_TIERS.includes(override as TenantTier) ? (override as TenantTier) : DEFAULT_TENANT_TIER;
}

export function getTenantFeatureGate(
  config: Partial<TenantConfig> | null | undefined,
  feature: TenantFeature,
): boolean {
  const tier = resolveTenantTier(config);
  const fullGate = CONFIGURED_TENANT_FEATURE_GATES(config, tier);
  return fullGate[feature] ?? false;
}

export function assertAllowedInferenceRegion(
  config: Partial<TenantConfig> | null | undefined,
  region: string | null | undefined,
): string {
  if (!region) {
    throw new Error('An inference region is required for this tenant.');
  }

  const residency = config?.dataResidency ?? 'india';
  const allowedRegions: readonly InferenceRegion[] = residency === 'india' ? INDIA_INFERENCE_REGIONS : GLOBAL_INFERENCE_REGIONS;
  const parsed = region as InferenceRegion;

  if (!allowedRegions.includes(parsed)) {
    throw new Error(
      `The tenant is configured for ${residency} residency, so inference region ${region} is not permitted. Use one of ${allowedRegions.join(', ')}.`,
    );
  }

  return region;
}

export interface TenantRuntimePolicy {
  tier: TenantTier;
  dataResidency: 'india' | 'global';
  inferenceRegion: InferenceRegion | null;
  featureGates: Partial<Record<TenantFeature, boolean>>;
  onboardingComplete: boolean;
}

export function resolveTenantRuntimePolicy(config: Partial<TenantConfig> | null | undefined): TenantRuntimePolicy {
  const tier = resolveTenantTier(config);
  const featureGates = CONFIGURED_TENANT_FEATURE_GATES(config, tier);
  const residency = config?.dataResidency ?? 'india';
  const inferenceRegion = config?.inferenceRegion ?? (residency === 'india' ? 'ap-south-1' : null);

  return {
    tier,
    dataResidency: residency,
    inferenceRegion: inferenceRegion && GLOBAL_INFERENCE_REGIONS.includes(inferenceRegion as InferenceRegion)
      ? (inferenceRegion as InferenceRegion)
      : null,
    featureGates,
    onboardingComplete: !!config?.onboardingComplete || !!config?.onboarding?.status && config.onboarding.status === 'active',
  };
}

export async function syncTenantPolicy(tenantId: string, config: Partial<TenantConfig> | null | undefined): Promise<TenantRuntimePolicy> {
  const runtime = resolveTenantRuntimePolicy(config);
  const nextConfig = {
    ...(config ?? {}),
    tier: runtime.tier,
    dataResidency: runtime.dataResidency,
    inferenceRegion: runtime.inferenceRegion,
    featureGates: runtime.featureGates,
  } as TenantConfig;

  const { prisma } = await import('./db.js');
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { config: nextConfig as never },
  });

  return runtime;
}

function CONFIGURED_TENANT_FEATURE_GATES(
  config: Partial<TenantConfig> | null | undefined,
  tier: TenantTier,
): Partial<Record<TenantFeature, boolean>> {
  const defaultGates = DEFAULT_TENANT_FEATURE_GATES[tier];
  const overrides = config?.featureGates ?? {};

  return TENANT_FEATURES.reduce<Partial<Record<TenantFeature, boolean>>>((acc, feature) => {
    const hasOverride = Object.prototype.hasOwnProperty.call(overrides, feature);
    acc[feature] = hasOverride ? Boolean(overrides[feature]) : Boolean(defaultGates[feature]);
    return acc;
  }, {});
}
