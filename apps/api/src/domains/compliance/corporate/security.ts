/**
 * Security policy, MFA enforcement at the point of use, and backups
 * (docs/plan/compliance.md, H — CMP-COR-002).
 *
 * `lib/auth.ts` is where a second factor is checked at *login*. This module
 * is where it is checked at the point of *use*: an approve-shaped action this
 * workstream owns (a refund, an MCA filing, an e-signature request) refuses a
 * session that has not completed MFA when the session's role is on the
 * policy's list — `stepUpVerified` on the token is only ever set `true` by a
 * completed `/auth/mfa/verify`, so it is a direct, checkable fact about how
 * this particular session came to exist, not a role-slug comparison.
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { prisma, unscopedPrisma } from '../../../platform/db.js';
import { currentAuth } from '../../../platform/context.js';
import { ApiError } from '../../../platform/errors.js';
import { assertCan } from '../../../platform/permissions.js';
import { auditWrite } from '../../../platform/audit.js';
import { raiseException } from '../../../platform/exceptions.js';

const DEFAULT_MFA_ROLES = ['finance_head', 'chairman'];

export async function securityPolicy() {
  const auth = currentAuth();
  const existing = await prisma.securityPolicy.findFirst({ where: { tenantId: auth.tenantId } });
  if (existing) return existing;
  return prisma.securityPolicy.create({
    data: { tenantId: auth.tenantId, mfaRequiredForRoleSlugs: DEFAULT_MFA_ROLES },
  });
}

export async function updateSecurityPolicy(input: {
  mfaRequiredForRoleSlugs?: string[];
  sessionHours?: number;
  passwordMinLength?: number;
}) {
  await assertCan({ resource: 'security_settings', verb: 'edit' });
  const current = await securityPolicy();
  const updated = await prisma.securityPolicy.update({
    where: { id: current.id },
    data: {
      ...(input.mfaRequiredForRoleSlugs !== undefined ? { mfaRequiredForRoleSlugs: input.mfaRequiredForRoleSlugs } : {}),
      ...(input.sessionHours !== undefined ? { sessionHours: input.sessionHours } : {}),
      ...(input.passwordMinLength !== undefined ? { passwordMinLength: input.passwordMinLength } : {}),
    },
  });
  await auditWrite({
    action: 'update',
    subjectType: 'security_policy',
    subjectId: updated.id,
    before: { mfaRequiredForRoleSlugs: current.mfaRequiredForRoleSlugs },
    after: { mfaRequiredForRoleSlugs: updated.mfaRequiredForRoleSlugs },
    force: true,
  });
  return updated;
}

/**
 * CMP-COR-002: refuses an approve-shaped action when the current session's
 * role is named in the policy and either MFA is not enrolled, or this
 * particular session did not come from a completed MFA challenge.
 */
export async function assertStepUpForApprove(actionLabel: string): Promise<void> {
  const auth = currentAuth();
  const policy = await securityPolicy();
  if (!policy.mfaRequiredForRoleSlugs.includes(auth.roleSlug ?? '')) return;

  if (!auth.userId) {
    throw ApiError.forbidden(`${actionLabel} requires a second factor for the ${auth.roleSlug} role.`);
  }

  const user = await unscopedPrisma.user.findFirst({ where: { id: auth.userId } });
  if (!user?.mfaEnabledAt) {
    throw ApiError.forbidden(
      `${actionLabel} requires MFA, and the ${auth.roleSlug} role has not enrolled it yet. Enrol under Security before trying again.`,
      undefined,
    );
  }

  if (!auth.stepUpVerified) {
    throw ApiError.forbidden(
      `${actionLabel} requires the second factor for this session. Sign out and back in, completing the MFA prompt, before trying again.`,
      undefined,
    );
  }
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

async function resolveOwnerPartyId(tenantId: string, roleSlug: string): Promise<string | null> {
  const affiliation = await unscopedPrisma.affiliation.findFirst({
    where: { tenantId, roleSlug, status: 'active' },
    select: { partyId: true },
  });
  return affiliation?.partyId ?? null;
}

export interface BackupOutcome {
  status: 'completed' | 'failed' | 'skipped';
  path?: string;
  sizeBytes?: number;
  sha256?: string;
  error?: string;
}

/**
 * Runs `pg_dump` via `child_process` to `BACKUP_DIR/kaizen-<date>.sql.gz` when
 * `BACKUP_DIR` is set. Unset is a deliberately quiet no-op — a tenant running
 * this against a managed Postgres with its own snapshot policy should not see
 * a daily failure notification for a job it never asked to run.
 */
export async function runBackup(tenantId: string): Promise<BackupOutcome> {
  const dir = process.env.BACKUP_DIR;
  if (!dir) return { status: 'skipped' };

  const date = new Date().toISOString().slice(0, 10);
  const path = `${dir}/kaizen-${date}.sql.gz`;

  const run = await unscopedPrisma.backupRun.create({
    data: { tenantId, status: 'running', path },
  });

  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is not set.');

    await new Promise<void>((resolve, reject) => {
      const dump = spawn('pg_dump', [databaseUrl], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      dump.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const gzip = createGzip();
      const out = createWriteStream(path);
      dump.on('error', reject);
      pipeline(dump.stdout, gzip, out).then(resolve, reject);
      dump.on('close', (code) => {
        if (code !== 0) reject(new Error(stderr || `pg_dump exited with code ${code}`));
      });
    });

    const sizeBytes = statSync(path).size;
    const hash = await hashFile(path);

    await unscopedPrisma.backupRun.update({
      where: { id: run.id },
      data: { status: 'completed', finishedAt: new Date(), sizeBytes, sha256: hash },
    });

    return { status: 'completed', path, sizeBytes, sha256: hash };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await unscopedPrisma.backupRun.update({
      where: { id: run.id },
      data: { status: 'failed', finishedAt: new Date(), error: message },
    });

    const ownerPartyId = (await resolveOwnerPartyId(tenantId, 'chairman')) ?? (await resolveOwnerPartyId(tenantId, 'finance_head'));
    await raiseException({
      code: 'CMP_BACKUP_FAILED',
      label: 'Daily backup failed',
      severity: 'S3_HIGH_RISK',
      subjectType: 'backup_run',
      subjectId: run.id,
      domain: 'cmp',
      detail: `pg_dump failed: ${message}`,
      ownerPartyId,
      triggerFingerprint: `backup_failed_${date}`,
      ladderRung: 1,
    });

    return { status: 'failed', error: message };
  }
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const rs = createReadStream(path);
    rs.on('data', (chunk) => hash.update(chunk));
    rs.on('end', () => resolve(hash.digest('hex')));
    rs.on('error', reject);
  });
}

export async function listBackups() {
  await assertCan({ resource: 'security_settings', verb: 'view' });
  const auth = currentAuth();
  return prisma.backupRun.findMany({ where: { tenantId: auth.tenantId }, orderBy: { startedAt: 'desc' }, take: 90 });
}
