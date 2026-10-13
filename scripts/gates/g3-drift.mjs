// G3 (schema and migration drift): the migrations replay to the schema, and no
// CI step changes the schema by `db push` (CI-GATES-DRAFT section 1, G3).
//
// The replay itself needs a running Postgres: `db:drift` runs `prisma migrate diff`
// from the migrations to the schema, against a shadow database, and CI runs it as a
// step in the `test` job (apps/api/package.json db:drift; ci.yml). That is the
// drift check, and it is not repeated here. This gate checks its wiring: the script
// compares in the right direction and fails on a diff, the job that runs it
// supplies the shadow database, and no workflow uses `db push`, which the draft
// names as the thing G3 cannot be enforced without removing.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readRepoText, jobsOf, runCommandsOf, envKeysOf, readWorkflows } from './ci-wiring.mjs';
import { REPO_ROOT } from './lib.mjs';

export const G3_SCRIPT = 'db:drift';
export const G3_SCRIPT_PARTS = [
  'prisma migrate diff',
  '--from-migrations prisma/migrations',
  '--to-schema-datamodel prisma/schema',
  '--shadow-database-url',
  '--exit-code',
  'SHADOW_DATABASE_URL',
];
export const G3_STEP = 'pnpm --filter @kaizen/api db:drift';
export const G3_SHADOW_KEY = 'SHADOW_DATABASE_URL';
export const G3_MIGRATIONS = 'apps/api/prisma/migrations';
export const G3_PUSH = /\bdb push\b|\bdb:push\b/;

/**
 * @param {{
 *   apiPkg: { scripts?: Record<string, string> },
 *   workflows: Array<{ rel: string, text: string }>,
 *   migrationCount: number,
 * }} input
 * @returns {string[]}
 */
export function checkG3({ apiPkg, workflows, migrationCount }) {
  const problems = [];
  const script = apiPkg?.scripts?.[G3_SCRIPT] ?? '';
  if (!script) {
    problems.push(`G3 apps/api/package.json: no "${G3_SCRIPT}" script.`);
  } else {
    for (const part of G3_SCRIPT_PARTS) {
      if (!script.includes(part)) problems.push(`G3 apps/api/package.json: "${G3_SCRIPT}" does not contain "${part}".`);
    }
  }
  if (migrationCount < 1) problems.push(`G3 ${G3_MIGRATIONS}: no migration has a migration.sql.`);

  let driftSteps = 0;
  for (const wf of workflows) {
    for (const [name, lines] of jobsOf(wf.text)) {
      const steps = runCommandsOf(lines);
      if (steps.includes(G3_STEP)) {
        driftSteps += 1;
        // The shadow database is the job's own: the replay runs into it, never into the app database.
        if (!envKeysOf(lines).includes(G3_SHADOW_KEY)) {
          problems.push(`G3 ${wf.rel}: job "${name}" runs ${G3_STEP} without ${G3_SHADOW_KEY} in its env.`);
        }
      }
      for (const step of steps) {
        if (G3_PUSH.test(step)) {
          problems.push(`G3 ${wf.rel}: job "${name}" changes the schema with "${step}". Migrations only (CLAUDE.md).`);
        }
      }
    }
  }
  if (driftSteps === 0) problems.push(`G3 .github/workflows: no live "${G3_STEP}" step in any job.`);
  return problems;
}

/** Migration directories that hold a migration.sql, as the replay reads them. */
export function countMigrations(root = REPO_ROOT) {
  const full = join(root, G3_MIGRATIONS);
  if (!existsSync(full)) return 0;
  return readdirSync(full, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && existsSync(join(full, entry.name, 'migration.sql')),
  ).length;
}

export function runG3({ root = REPO_ROOT } = {}) {
  const apiPkg = JSON.parse(readRepoText('apps/api/package.json', root));
  const problems = checkG3({ apiPkg, workflows: readWorkflows(root), migrationCount: countMigrations(root) });
  return {
    id: 'G3',
    title: 'migration drift check wired (db:drift in CI, no db push)',
    problems,
    summary:
      problems.length === 0
        ? `db:drift runs in CI against a shadow database; ${countMigrations(root)} migrations; no db push`
        : 'not wired',
  };
}
