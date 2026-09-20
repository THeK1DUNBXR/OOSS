/**
 * HCM — time jobs (docs/hcm/time.md).
 *
 * Not registered into `ALL_JOBS` — the scaffold rule keeps `scheduler.ts`
 * untouched by every workstream. **Integrator action**: spread `JOBS` from
 * this file into `ALL_JOBS` in `apps/api/src/jobs/scheduler.ts`, the same way
 * `COMPLIANCE_JOBS` is spread in today, and add the two imports it needs
 * (`deriveAttendanceFromClockEvents`, `runCompOffExpiry` from
 * `../domains/hcm/time.js`) or re-export this file's `JOBS` const.
 */
import type { JobDefinition } from '../scheduler.js';
import { deriveAttendanceFromClockEvents, runCompOffExpiry } from '../../domains/hcm/time.js';

export const JOBS: JobDefinition[] = [
  {
    name: 'runDeriveAttendanceFromClockEventsJob',
    label: 'Derive yesterday’s attendance from clock events against the roster (HCM-TIME)',
    automationClass: 'threshold_response',
    cron: '0 3 * * *',
    run: async () => deriveAttendanceFromClockEvents(),
  },
  {
    name: 'runCompOffExpiryJob',
    label: 'Comp-off expiry sweep (HCM-TIME)',
    automationClass: 'threshold_response',
    cron: '0 4 * * *',
    run: async () => runCompOffExpiry(),
  },
];
