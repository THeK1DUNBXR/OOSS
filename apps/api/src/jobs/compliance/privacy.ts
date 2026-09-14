import type { JobDefinition } from '../scheduler.js';
import {
  flagMajorityTransitions,
  detectOverdueDataRequests,
  runBreachLadder,
  runRetentionReport,
  runAccessReview,
} from '../../domains/compliance/privacy.js';

const counted = (n: number) => ({ processed: n, notified: n, skippedIdempotent: 0, errors: [] });

/** Compliance — privacy. Registered into ALL_JOBS through jobs/compliance/index.ts. */
export const JOBS: JobDefinition[] = [
  {
    name: 'runPrivacyMajorityTransitionJob',
    label: 'CMP-DPD: students who turned 18 (consent basis changes)',
    automationClass: 'data_maintenance',
    cron: '0 4 1 * *',
    run: async () => counted(await flagMajorityTransitions()),
  },
  {
    name: 'runPrivacyDataRequestOverdueJob',
    label: 'CMP_DPD_REQUEST_OVERDUE: data-principal requests past their due date',
    automationClass: 'escalation_routing',
    cron: '0 5 * * *',
    run: async () => counted(await detectOverdueDataRequests()),
  },
  {
    name: 'runPrivacyBreachLadderJob',
    label: 'CMP_DPD_BREACH_72H: 24/48/72h breach-notification ladder',
    automationClass: 'threshold_response',
    cron: '0 * * * *',
    run: async () => counted(await runBreachLadder()),
  },
  {
    name: 'runPrivacyRetentionReportJob',
    label: 'Retention report — reads EventRecord.retentionClass, reports only',
    automationClass: 'data_maintenance',
    cron: '0 3 1 * *',
    run: async () => {
      const { snapshot } = await runRetentionReport();
      return counted(snapshot.length);
    },
  },
  {
    name: 'runPrivacyAccessReviewJob',
    label: 'CMP_DPD_STALE_ACCESS: weekly access review',
    automationClass: 'routine_administration',
    cron: '0 6 * * 1',
    run: async () => counted(await runAccessReview()),
  },
];
