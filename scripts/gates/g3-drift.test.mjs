// G3 (migration drift wired): db:drift compares the migrations with the schema in
// the right direction, the CI job that runs it has a shadow database, and no
// workflow uses `db push`. The replay itself runs in CI (ci.yml, the test job), so
// these fixtures check the wiring only. The last test reads the real repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkG3, runG3 } from './g3-drift.mjs';

const DRIFT =
  'test -n "$SHADOW_DATABASE_URL" || { echo \'SHADOW_DATABASE_URL is required\' >&2; exit 1; } && ' +
  'prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema ' +
  '--shadow-database-url "$SHADOW_DATABASE_URL" --exit-code';
const API_PKG = { scripts: { 'db:drift': DRIFT } };
const REL = '.github/workflows/ci.yml';

function workflow({ env = true, steps = ['pnpm --filter @kaizen/api db:drift'] } = {}) {
  return [
    'name: CI',
    'on:',
    '  pull_request:',
    'jobs:',
    '  test:',
    '    runs-on: ubuntu-latest',
    ...(env ? ['    env:', '      SHADOW_DATABASE_URL: postgresql://kaizen:kaizen@127.0.0.1:5432/kaizen_shadow'] : []),
    '    steps:',
    ...steps.map((s) => `      - run: ${s}`),
    '',
  ].join('\n');
}

test('passes when the drift script compares migrations to schema and the test job runs it with a shadow database', () => {
  const problems = checkG3({ apiPkg: API_PKG, workflows: [{ rel: REL, text: workflow() }], migrationCount: 10 });
  assert.deepEqual(problems, []);
});

test('fails when db:drift does not fail on a diff (no --exit-code)', () => {
  const pkg = { scripts: { 'db:drift': DRIFT.replace(' --exit-code', '') } };
  const problems = checkG3({ apiPkg: pkg, workflows: [{ rel: REL, text: workflow() }], migrationCount: 10 });
  assert.deepEqual(problems, ['G3 apps/api/package.json: "db:drift" does not contain "--exit-code".']);
});

test('fails when db:drift compares the schema against the migrations the wrong way round', () => {
  const pkg = {
    scripts: {
      'db:drift': DRIFT.replace('--from-migrations prisma/migrations', '--from-schema-datamodel prisma/schema').replace(
        '--to-schema-datamodel prisma/schema',
        '--to-migrations prisma/migrations',
      ),
    },
  };
  const problems = checkG3({ apiPkg: pkg, workflows: [{ rel: REL, text: workflow() }], migrationCount: 10 });
  assert.deepEqual(problems, [
    'G3 apps/api/package.json: "db:drift" does not contain "--from-migrations prisma/migrations".',
    'G3 apps/api/package.json: "db:drift" does not contain "--to-schema-datamodel prisma/schema".',
  ]);
});

test('fails when the job that runs db:drift has no SHADOW_DATABASE_URL', () => {
  const problems = checkG3({
    apiPkg: API_PKG,
    workflows: [{ rel: REL, text: workflow({ env: false }) }],
    migrationCount: 10,
  });
  assert.deepEqual(problems, [
    `G3 ${REL}: job "test" runs pnpm --filter @kaizen/api db:drift without SHADOW_DATABASE_URL in its env.`,
  ]);
});

test('fails when a workflow uses db push, which changes the schema outside a migration', () => {
  const text = workflow({
    steps: ['pnpm --filter @kaizen/api db:drift', 'pnpm --filter @kaizen/api exec prisma db push'],
  });
  const problems = checkG3({ apiPkg: API_PKG, workflows: [{ rel: REL, text }], migrationCount: 10 });
  assert.deepEqual(problems, [
    `G3 ${REL}: job "test" changes the schema with "pnpm --filter @kaizen/api exec prisma db push". Migrations only (CLAUDE.md).`,
  ]);
});

test('a commented-out db push line is not a step', () => {
  const text = workflow({ steps: ['pnpm --filter @kaizen/api db:drift'] }).replace(
    '    steps:',
    '    steps:\n      # - run: pnpm db:push',
  );
  assert.deepEqual(checkG3({ apiPkg: API_PKG, workflows: [{ rel: REL, text }], migrationCount: 10 }), []);
});

test('fails when no job runs db:drift at all', () => {
  const problems = checkG3({
    apiPkg: API_PKG,
    workflows: [{ rel: REL, text: workflow({ steps: ['pnpm test'] }) }],
    migrationCount: 10,
  });
  assert.deepEqual(problems, ['G3 .github/workflows: no live "pnpm --filter @kaizen/api db:drift" step in any job.']);
});

test('fails when there are no migrations to replay', () => {
  const problems = checkG3({ apiPkg: API_PKG, workflows: [{ rel: REL, text: workflow() }], migrationCount: 0 });
  assert.deepEqual(problems, ['G3 apps/api/prisma/migrations: no migration has a migration.sql.']);
});

test('the real repository is wired', () => {
  const result = runG3();
  assert.deepEqual(result.problems, []);
  assert.equal(result.id, 'G3');
});
