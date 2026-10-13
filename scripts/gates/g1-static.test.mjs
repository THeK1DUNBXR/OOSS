// G1 (static checks wired): typecheck, lint and the Tailwind token check run in the
// CI static job as live steps. The fixtures are the workflow shapes the gate must
// catch; the last test reads the real repository, which must pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkG1, runG1 } from './g1-static.mjs';

const PKG = {
  scripts: {
    typecheck: 'pnpm --filter @kaizen/shared build && pnpm -r typecheck',
    lint: 'eslint . && node scripts/check-tailwind-tokens.mjs --check',
  },
};

function ci({ staticSteps = ['pnpm typecheck', 'pnpm lint'], otherJob = false } = {}) {
  const steps = staticSteps.map((s) => `      - run: ${s}`).join('\n');
  const job = [
    '  static:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    steps,
  ].join('\n');
  const other = otherJob
    ? ['  test:', '    runs-on: ubuntu-latest', '    steps:', '      - run: pnpm test'].join('\n')
    : '';
  return ['name: CI', 'on:', '  pull_request:', 'jobs:', job, other, ''].filter((l) => l !== '').join('\n');
}

test('passes when the scripts run the checks and the static job runs typecheck and lint', () => {
  assert.deepEqual(checkG1({ pkg: PKG, ciText: ci(), tokenScriptExists: true }), []);
});

test('fails when the static job no longer runs typecheck', () => {
  const problems = checkG1({ pkg: PKG, ciText: ci({ staticSteps: ['pnpm lint'] }), tokenScriptExists: true });
  assert.deepEqual(problems, ['G1 .github/workflows/ci.yml: job "static" does not run "pnpm typecheck".']);
});

test('a commented-out lint step does not count as a live step', () => {
  const text = ci({ staticSteps: ['pnpm typecheck'] }).replace(
    '      - uses: actions/checkout@v4',
    '      - uses: actions/checkout@v4\n      # - run: pnpm lint',
  );
  assert.deepEqual(checkG1({ pkg: PKG, ciText: text, tokenScriptExists: true }), [
    'G1 .github/workflows/ci.yml: job "static" does not run "pnpm lint".',
  ]);
});

test('a lint step in another job does not satisfy the static job', () => {
  const text = ci({ staticSteps: ['pnpm typecheck'], otherJob: true }).replace(
    '  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm test',
    '  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm lint',
  );
  assert.deepEqual(checkG1({ pkg: PKG, ciText: text, tokenScriptExists: true }), [
    'G1 .github/workflows/ci.yml: job "static" does not run "pnpm lint".',
  ]);
});

test('fails when lint stops running the Tailwind token check', () => {
  const pkg = { scripts: { ...PKG.scripts, lint: 'eslint .' } };
  assert.deepEqual(checkG1({ pkg, ciText: ci(), tokenScriptExists: true }), [
    'G1 package.json: the "lint" script no longer runs "node scripts/check-tailwind-tokens.mjs --check".',
  ]);
});

test('fails when the token script is missing, and when there is no typecheck script', () => {
  const pkg = { scripts: { lint: PKG.scripts.lint } };
  assert.deepEqual(checkG1({ pkg, ciText: ci(), tokenScriptExists: false }), [
    'G1 package.json: no "typecheck" script.',
    'G1 scripts/check-tailwind-tokens.mjs: the Tailwind token check script is missing.',
  ]);
});

test('fails when there is no static job at all', () => {
  const text = 'jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm test\n';
  assert.deepEqual(checkG1({ pkg: PKG, ciText: text, tokenScriptExists: true }), [
    'G1 .github/workflows/ci.yml: no "static" job runs the static checks.',
  ]);
});

test('the real repository is wired', () => {
  const result = runG1();
  assert.deepEqual(result.problems, []);
  assert.equal(result.id, 'G1');
});
