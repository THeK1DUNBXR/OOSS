// G2 (map freshness wired): `map:check` runs genmap in check mode, and the CI static
// job runs it. The fixtures are the shapes the gate must catch; the last test reads
// the real repository, which must pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkG2, runG2 } from './g2-map.mjs';

const PKG = { scripts: { 'map:check': 'node scripts/genmap.mjs --check' } };

function ci(steps = ['pnpm map:check']) {
  return [
    'name: CI',
    'jobs:',
    '  static:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    ...steps.map((s) => `      - run: ${s}`),
    '',
  ].join('\n');
}

test('passes when map:check runs genmap --check and the static job runs it', () => {
  assert.deepEqual(checkG2({ pkg: PKG, ciText: ci(), generatorExists: true, mapExists: true }), []);
});

test('fails when map:check no longer checks, or runs the generator without --check', () => {
  const pkg = { scripts: { 'map:check': 'node scripts/genmap.mjs' } };
  assert.deepEqual(checkG2({ pkg, ciText: ci(), generatorExists: true, mapExists: true }), [
    'G2 package.json: "map:check" must be "node scripts/genmap.mjs --check", found "node scripts/genmap.mjs".',
  ]);
});

test('fails when the static job does not run map:check', () => {
  assert.deepEqual(checkG2({ pkg: PKG, ciText: ci(['pnpm lint']), generatorExists: true, mapExists: true }), [
    'G2 .github/workflows/ci.yml: no live "pnpm map:check" step in the "static" job.',
  ]);
});

test('a commented-out map:check step does not count', () => {
  const text = ci(['pnpm lint']).replace(
    '      - run: pnpm lint',
    '      # - run: pnpm map:check\n      - run: pnpm lint',
  );
  assert.deepEqual(checkG2({ pkg: PKG, ciText: text, generatorExists: true, mapExists: true }), [
    'G2 .github/workflows/ci.yml: no live "pnpm map:check" step in the "static" job.',
  ]);
});

test('fails when the generator or the committed map is missing', () => {
  assert.deepEqual(checkG2({ pkg: PKG, ciText: ci(), generatorExists: false, mapExists: false }), [
    'G2 scripts/genmap.mjs: the map generator is missing.',
    'G2 docs/plan/MAP.md: the committed map is missing.',
  ]);
});

test('the real repository is wired', () => {
  const result = runG2();
  assert.deepEqual(result.problems, []);
  assert.equal(result.id, 'G2');
});
