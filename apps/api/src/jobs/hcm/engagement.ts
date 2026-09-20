/**
 * HCM — WS9 engagement jobs.
 *
 * Not wired into `jobs/scheduler.ts` — see "Wanted from the scaffold" in
 * docs/hcm/engagement.md for the one-line splice the integrator needs
 * (matching the `COMPLIANCE_JOBS` pattern in `jobs/compliance/index.ts`).
 */
import type { JobDefinition } from '../scheduler.js';
import { runHrCaseSlaCheck } from '../../domains/hcm/engagement.js';

export const JOBS: JobDefinition[] = [
  {
    name: 'hcm_engagement_hr_case_sla_check',
    label: 'HR case SLA breach check',
    automationClass: 'hr_case_sla',
    cron: '0 * * * *',
    run: runHrCaseSlaCheck,
  },
];
