import { describe, expect, it } from 'vitest';
import { nextTenantOnboardingState } from '@kaizen/shared';
import {
  resolveTenantRuntimePolicy,
  assertAllowedInferenceRegion,
  getTenantFeatureGate,
} from '../platform/tenantPolicy.js';

describe('tenant product foundations', () => {
  it('advances the tenant onboarding state machine across the required milestones', () => {
    expect(nextTenantOnboardingState('draft', 'START')).toBe('company_profile');
    expect(nextTenantOnboardingState('company_profile', 'SETUP_COMPANY')).toBe('statutory_configured');
    expect(nextTenantOnboardingState('statutory_configured', 'CONFIGURE_STATUTORY')).toBe('openings_imported');
    expect(nextTenantOnboardingState('openings_imported', 'IMPORT_OPENINGS')).toBe('verified');
    expect(nextTenantOnboardingState('verified', 'VERIFY')).toBe('active');
  });

  it('keeps India residency and feature gating tenant-safe by default', () => {
    const policy = resolveTenantRuntimePolicy({ tier: 'enterprise' });
    expect(policy.dataResidency).toBe('india');
    expect(policy.inferenceRegion).toBe('ap-south-1');
    expect(policy.featureGates.ai).toBe(true);
    expect(policy.featureGates.database_per_tenant).toBe(true);
    expect(getTenantFeatureGate({ tier: 'starter' }, 'ai')).toBe(false);
  });

  it('rejects an inference region outside the tenant residency policy', () => {
    expect(() => assertAllowedInferenceRegion({ dataResidency: 'india' }, 'ap-south-1')).not.toThrow();
    expect(() => assertAllowedInferenceRegion({ dataResidency: 'india' }, 'us-east-1')).toThrowError(/not permitted/i);
  });
});
