/**
 * Technology — governance seed (docs/plan/cio.md, workstream F). Idempotent:
 * dated tables are upserted by their natural key, and the control/policy
 * starter sets are upserted by code so re-running the seed against a tenant
 * that already has them only ever updates them in place.
 */

import { unscopedPrisma } from '../../platform/db.js';
import { currentTenantId } from '../../platform/context.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import type { Prisma } from '@prisma/client';

const BAND_SET_ID = 'v1';
const BAND_EFFECTIVE_FROM = new Date('2020-01-01T00:00:00.000Z');

const BANDS: Array<{ band: string; minScore: number }> = [
  { band: 'low', minScore: 1 },
  { band: 'medium', minScore: 6 },
  { band: 'high', minScore: 12 },
  { band: 'critical', minScore: 20 },
];

const REMEDIATION_EFFECTIVE_FROM = new Date('2020-01-01T00:00:00.000Z');
const REMEDIATION_RULES: Array<{ severity: string; days: number }> = [
  { severity: 'critical', days: 7 },
  { severity: 'high', days: 30 },
  { severity: 'medium', days: 90 },
  { severity: 'low', days: 180 },
];

interface ControlSeed {
  code: string;
  title: string;
  frameworkRefs: Prisma.InputJsonValue;
  frequencyDays: number;
}

// ISO 27001 Annex A (2022), a representative starter set — one row per
// control family the tenant is expected to keep evidence for.
const CONTROLS: ControlSeed[] = [
  { code: 'A.5.15', title: 'Access control policy', frameworkRefs: [{ framework: 'ISO27001', ref: 'A.5.15' }], frequencyDays: 365 },
  { code: 'A.5.23', title: 'Information security for use of cloud services', frameworkRefs: [{ framework: 'ISO27001', ref: 'A.5.23' }], frequencyDays: 365 },
  { code: 'A.5.30', title: 'ICT readiness for business continuity', frameworkRefs: [{ framework: 'ISO27001', ref: 'A.5.30' }], frequencyDays: 180 },
  { code: 'A.8.1', title: 'User endpoint devices', frameworkRefs: [{ framework: 'ISO27001', ref: 'A.8.1' }], frequencyDays: 180 },
  { code: 'A.8.2', title: 'Privileged access rights', frameworkRefs: [{ framework: 'ISO27001', ref: 'A.8.2' }], frequencyDays: 90 },
  { code: 'A.8.7', title: 'Protection against malware', frameworkRefs: [{ framework: 'ISO27001', ref: 'A.8.7' }], frequencyDays: 90 },
  { code: 'A.8.13', title: 'Information backup', frameworkRefs: [{ framework: 'ISO27001', ref: 'A.8.13' }], frequencyDays: 30 },
  { code: 'A.8.15', title: 'Logging', frameworkRefs: [{ framework: 'ISO27001', ref: 'A.8.15' }], frequencyDays: 90 },
  { code: 'A.8.16', title: 'Monitoring activities', frameworkRefs: [{ framework: 'ISO27001', ref: 'A.8.16' }], frequencyDays: 90 },
  { code: 'A.8.8', title: 'Management of technical vulnerabilities', frameworkRefs: [{ framework: 'ISO27001', ref: 'A.8.8' }], frequencyDays: 90 },
  { code: 'A.5.19', title: 'Information security in supplier relationships', frameworkRefs: [{ framework: 'ISO27001', ref: 'A.5.19' }], frequencyDays: 365 },
  { code: 'A.5.24', title: 'Information security incident management planning', frameworkRefs: [{ framework: 'ISO27001', ref: 'A.5.24' }], frequencyDays: 365 },
  { code: 'A.8.25', title: 'Secure development life cycle', frameworkRefs: [{ framework: 'ISO27001', ref: 'A.8.25' }], frequencyDays: 180 },
];

interface PolicySeed {
  code: string;
  title: string;
  body: string;
  appliesToRoleSlugs: string[];
  reacknowledgeMonths: number;
}

const POLICIES: PolicySeed[] = [
  {
    code: 'IT-POL-AUP',
    title: 'Acceptable use of technology',
    body:
      'Company systems, accounts and devices are provided for Kaizen Infinities\' work and are to be used accordingly. ' +
      'Keep credentials to yourself, lock your screen when you step away, and report a lost device or a suspected compromise ' +
      'to the technology desk the same day rather than waiting to see if it matters. Personal use that is occasional and does ' +
      'not interfere with your work, cost the company money, or put company data at risk is fine; installing unapproved ' +
      'software, connecting personal storage to move company data out, or using company systems for anything unlawful is not. ' +
      'Every account and device remains company property and may be reviewed as this policy and the law allow.',
    appliesToRoleSlugs: [],
    reacknowledgeMonths: 12,
  },
  {
    code: 'IT-POL-PWD-MFA',
    title: 'Password and multi-factor authentication',
    body:
      'Every account that can be protected by multi-factor authentication is to have it switched on — this is not optional ' +
      'for anyone who touches company systems. Choose a password you have not used anywhere else and are not sharing with ' +
      'anyone, including a colleague standing in for you; a shared password is a gap the technology desk cannot see. If you ' +
      'believe a password or authenticator has been exposed, change it and tell the technology desk immediately rather than ' +
      'waiting for the next scheduled reset. A password manager is provided and its use is expected — writing a password down ' +
      'where it can be found defeats the point of having one.',
    appliesToRoleSlugs: [],
    reacknowledgeMonths: 12,
  },
  {
    code: 'IT-POL-BYOD',
    title: 'Bring your own device and remote work',
    body:
      'A personal device used to reach company email, files or systems must carry a passcode or biometric lock, must be kept ' +
      'updated, and must be reported to the technology desk before it is enrolled so it can be covered by the same baseline a ' +
      'company laptop carries. Working from outside the office is fine over a trusted connection; avoid handling client or ' +
      'financial data on open public wifi, and use the company VPN when the network is not one you control. Losing a device ' +
      'that has held company data — personal or company-owned — is reported the same day, so access from it can be revoked ' +
      'before it becomes a bigger problem than a lost phone.',
    appliesToRoleSlugs: [],
    reacknowledgeMonths: 12,
  },
];

async function resolveDrafter(tenantId: string): Promise<string> {
  const affiliation = await unscopedPrisma.affiliation.findFirst({
    where: { tenantId, roleSlug: 'hr_ops_manager', status: 'active' },
    orderBy: [{ primaryFlag: 'desc' }, { createdAt: 'asc' }],
  });
  if (affiliation) return affiliation.partyId;
  const any = await unscopedPrisma.affiliation.findFirst({ where: { tenantId, status: 'active' }, orderBy: { createdAt: 'asc' } });
  return any?.partyId ?? 'system';
}

export async function seedGovernance(): Promise<void> {
  const tenantId = currentTenantId();

  // Risk scoring bands (dated table, one version so far).
  const existingBandSet = await unscopedPrisma.itRiskScoringBand.findFirst({ where: { tenantId, setId: BAND_SET_ID } });
  if (!existingBandSet) {
    for (const b of BANDS) {
      await unscopedPrisma.itRiskScoringBand.create({
        data: { tenantId, setId: BAND_SET_ID, band: b.band, minScore: b.minScore, effectiveFrom: BAND_EFFECTIVE_FROM },
      });
    }
  }

  // Remediation SLA by severity (dated table).
  for (const r of REMEDIATION_RULES) {
    const existing = await unscopedPrisma.itRemediationRule.findFirst({
      where: { tenantId, severity: r.severity, effectiveFrom: REMEDIATION_EFFECTIVE_FROM },
    });
    if (!existing) {
      await unscopedPrisma.itRemediationRule.create({
        data: { tenantId, severity: r.severity, days: r.days, effectiveFrom: REMEDIATION_EFFECTIVE_FROM },
      });
    }
  }

  // Control library.
  const drafter = await resolveDrafter(tenantId);
  for (const c of CONTROLS) {
    const existing = await unscopedPrisma.itControl.findFirst({ where: { tenantId, code: c.code } });
    if (existing) {
      await unscopedPrisma.itControl.update({
        where: { id: existing.id },
        data: { title: c.title, frameworkRefs: c.frameworkRefs, frequencyDays: c.frequencyDays },
      });
    } else {
      const recordCode = await nextRecordCode('CTL');
      await unscopedPrisma.itControl.create({
        data: {
          tenantId,
          recordCode,
          code: c.code,
          title: c.title,
          frameworkRefs: c.frameworkRefs,
          ownerPartyId: drafter,
          frequencyDays: c.frequencyDays,
          status: 'active',
        },
      });
    }
  }

  // Starter policy drafts.
  for (const p of POLICIES) {
    const existing = await unscopedPrisma.itPolicyDocument.findFirst({ where: { tenantId, code: p.code } });
    if (existing) continue; // never overwrite a body once a real draft/publication exists
    const recordCode = await nextRecordCode('ITP');
    await unscopedPrisma.itPolicyDocument.create({
      data: {
        tenantId,
        recordCode,
        code: p.code,
        title: p.title,
        body: p.body,
        version: 1,
        status: 'draft',
        drafterPartyId: drafter,
        appliesToRoleSlugs: p.appliesToRoleSlugs,
        reacknowledgeMonths: p.reacknowledgeMonths,
      },
    });
  }
}
