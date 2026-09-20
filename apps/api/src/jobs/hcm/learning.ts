/**
 * HCM — learning jobs (docs/hcm/learning.md).
 *
 * Not wired into `jobs/scheduler.ts` — that file is common infrastructure no
 * workstream edits directly (see the WS brief). `LEARNING_JOBS` is exported
 * in the same `JobDefinition[]` shape `jobs/compliance/index.ts` uses, ready
 * for the integrator to spread into `ALL_JOBS` the same way `COMPLIANCE_JOBS`
 * is spread in today.
 */
import type { JobDefinition } from '../scheduler.js';
import { runCertificationExpiryLadder, runMandatoryTrainingOverdueCheck } from '../../domains/hcm/learning.js';

export const LEARNING_JOBS: JobDefinition[] = [
  {
    name: 'hcm_learning_certification_expiry',
    label: 'Certification expiry ladder (90/30/7 days)',
    automationClass: 'routine_administration',
    cron: '0 3 * * *',
    run: runCertificationExpiryLadder,
  },
  {
    name: 'hcm_learning_mandatory_overdue',
    label: 'Mandatory training overdue check',
    automationClass: 'routine_administration',
    cron: '30 3 * * *',
    run: runMandatoryTrainingOverdueCheck,
  },
];

/** Registers both jobs against a scheduler-shaped registry, for a host that supports dynamic registration instead of a static array spread. */
export function registerLearningJobs(register: (job: JobDefinition) => void): void {
  for (const job of LEARNING_JOBS) register(job);
}
