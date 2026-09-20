/**
 * HCM — leavepolicy jobs.
 *
 * Not yet spliced into `ALL_JOBS` (see `jobs/scheduler.ts`, owned by the
 * scaffold) or a `jobs/hcm/index.ts` — none exists yet for this workstream
 * group, mirroring `jobs/compliance/index.ts`'s `COMPLIANCE_JOBS` pattern.
 * The integrator wires this in without editing scheduler.ts by giving it a
 * `jobs/hcm/index.ts` exporting `HCM_JOBS` the same way, then spreading that
 * into `ALL_JOBS` — see docs/hcm/leavepolicy.md "Wanted from the scaffold".
 */
import type { JobDefinition } from '../scheduler.js';
import { runMonthlyAccrual } from '../../domains/hcm/leavepolicy.js';

export const JOBS: JobDefinition[] = [
  {
    name: 'runLeaveAccrualJob',
    label: 'Monthly leave accrual (HCM-LVP-005)',
    automationClass: 'financial_processing',
    cron: '0 2 1 * *',
    run: async () => runMonthlyAccrual(),
  },
];
