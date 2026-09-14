import type { JobDefinition } from '../scheduler.js';
import { runLeaveYearClose, runWeeklyHoursCheck, runPoshOverdueCheck } from '../../domains/compliance/labour.js';

/** Compliance — labour. Registered into ALL_JOBS through jobs/compliance/index.ts. */
export const JOBS: JobDefinition[] = [
  {
    name: 'runLeaveYearCloseJob',
    label: 'Leave carry-forward and lapse at FY close (CMP-LAB-004)',
    automationClass: 'financial_processing',
    cron: '0 1 1 4 *',
    run: async () => runLeaveYearClose(),
  },
  {
    name: 'runWeeklyHoursCheckJob',
    label: 'Weekly working-hours cap check and overtime accrual (CMP-LAB-002)',
    automationClass: 'threshold_response',
    cron: '0 2 * * 1',
    run: async () => runWeeklyHoursCheck(),
  },
  {
    name: 'runPoshOverdueCheckJob',
    label: 'POSH inquiry overdue detector (CMP-LAB-001)',
    automationClass: 'escalation_routing',
    cron: '0 7 * * *',
    run: async () => runPoshOverdueCheck(),
  },
];
