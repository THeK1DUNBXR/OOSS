/** Compliance — corporate. Registered into ALL_JOBS through jobs/compliance/index.ts. */
import type { JobDefinition, JobResult } from '../scheduler.js';
import { currentAuth } from '../../platform/context.js';
import { runBackup } from '../../domains/compliance/corporate/security.js';
import { detectMissingFircs } from '../../domains/compliance/corporate/fema.js';

function counted(n: number): JobResult {
  return { processed: n, notified: n, skippedIdempotent: 0, errors: [] };
}

export const JOBS: JobDefinition[] = [
  {
    name: 'runComplianceBackupJob',
    label: 'Daily backup (pg_dump, when BACKUP_DIR is set)',
    automationClass: 'data_maintenance',
    cron: '0 2 * * *',
    run: async () => {
      const auth = currentAuth();
      const outcome = await runBackup(auth.tenantId);
      if (outcome.status === 'failed') return { processed: 1, notified: 1, skippedIdempotent: 0, errors: [outcome.error ?? 'backup failed'] };
      if (outcome.status === 'skipped') return { processed: 0, notified: 0, skippedIdempotent: 1, errors: [] };
      return counted(1);
    },
  },
  {
    name: 'runFemaFircSweepJob',
    label: 'Foreign receipts missing a FIRC (CMP_FEMA_FIRC_MISSING)',
    automationClass: 'threshold_response',
    cron: '0 7 1 * *',
    run: async () => counted(await detectMissingFircs()),
  },
];
