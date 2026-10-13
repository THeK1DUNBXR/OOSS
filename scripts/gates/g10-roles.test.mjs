// G10 check (c)(1): the role-label and holder-email ratchet. The fixtures name each
// label the gate knows, the look-alikes that must stay quiet, and the scope rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanSource, inScope, checkRoles, ROLE_LABELS, G10_RULES, ROOTS } from './g10-roles.mjs';

const DOMAIN = 'apps/api/src/domains/fixture.ts';

test('the rules are the four role labels and the holder email domain the draft names', () => {
  assert.deepEqual(ROLE_LABELS, ['finance_head', 'accountant', 'chairman', 'internal finance head']);
  assert.deepEqual(G10_RULES, [...ROLE_LABELS, '@kaizen.co.in']);
});

test('the scope is the finance, HCM, compliance, platform, jobs and shared roots', () => {
  assert.deepEqual(ROOTS, [
    'apps/api/src/domains',
    'apps/api/src/routes',
    'apps/api/src/platform',
    'apps/api/src/jobs',
    'packages/shared/src',
  ]);
});

test('finds a literal equal to a role label', () => {
  const found = scanSource(DOMAIN, "const r = 'finance_head';\nconst c = 'accountant';\nconst h = 'chairman';\n");
  assert.deepEqual(
    found.map((f) => [f.line, f.rule]),
    [
      [1, 'finance_head'],
      [2, 'accountant'],
      [3, 'chairman'],
    ],
  );
});

test('finds a label contained as a whole word in a longer literal', () => {
  const found = scanSource(DOMAIN, "throw new Error('Only the internal finance head may sign this.');\n");
  assert.deepEqual(
    found.map((f) => f.rule),
    ['internal finance head'],
  );
});

test('finds a holder email literal', () => {
  const found = scanSource(DOMAIN, "const who = 'chairman@kaizen.co.in';\n");
  assert.deepEqual(
    found.map((f) => f.rule),
    ['chairman', '@kaizen.co.in'],
  );
});

test('finds a label inside a template literal, including a template span', () => {
  const found = scanSource(DOMAIN, 'const m = `the ${who} is the accountant`;\nconst n = `${who} is the chairman`;\n');
  assert.deepEqual(
    found.map((f) => [f.line, f.rule]),
    [
      [1, 'accountant'],
      [2, 'chairman'],
    ],
  );
});

test('one literal that names two labels is two findings', () => {
  const found = scanSource(
    DOMAIN,
    "const ladder = ['finance_head', 'chairman'];\nconst both = 'accountant and chairman';\n",
  );
  assert.deepEqual(
    found.map((f) => [f.line, f.rule]),
    [
      [1, 'finance_head'],
      [1, 'chairman'],
      [2, 'accountant'],
      [2, 'chairman'],
    ],
  );
});

test('matches case-insensitively, so a display label such as "Accountant" is a hit', () => {
  const found = scanSource(DOMAIN, 'const label = "Chairman\'s Office";\n');
  assert.deepEqual(
    found.map((f) => f.rule),
    ['chairman'],
  );
});

test('does not flag look-alikes that only share a prefix or suffix with a label', () => {
  const text = [
    "const a = 'accountants';",
    "const b = 'chairmanship';",
    "const c = 'chairman_id';",
    "const d = 'finance_headline';",
    "const e = 'my_accountant';",
    "const f = 'internal finance heads';",
    '',
  ].join('\n');
  assert.deepEqual(scanSource(DOMAIN, text), []);
});

test('does not flag a comment that names a label', () => {
  const text = [
    '// the chairman approves this, and the accountant only records it',
    '/* finance_head */',
    '/** @kaizen.co.in is the old domain */',
    '',
  ].join('\n');
  assert.deepEqual(scanSource(DOMAIN, text), []);
});

test('does not flag a module path that names a label, because a path names a file', () => {
  const text = [
    "import { x } from './accountant.js';",
    "export { y } from './chairman/index.js';",
    "const m = await import('./finance_head.js');",
    "const r = require('./accountant');",
    '',
  ].join('\n');
  assert.deepEqual(scanSource(DOMAIN, text), []);
});

test('the seed folder is out of scope, because seed data is where the labels may live', () => {
  assert.equal(inScope('apps/api/src/seed/bootstrap.ts'), false);
  assert.equal(inScope('apps/api/src/seed/compliance/statutory.ts'), false);
});

test('test files are out of scope wherever they sit', () => {
  assert.equal(inScope('apps/api/src/tests/statutoryApproval.test.ts'), false);
  assert.equal(inScope('apps/api/src/domains/tests/fixture.ts'), false);
  assert.equal(inScope('packages/shared/src/fixture.spec.ts'), false);
  assert.equal(inScope('apps/api/src/__tests__/fixture.ts'), false);
});

test('production files under the roots are in scope', () => {
  assert.equal(inScope('apps/api/src/domains/statutory.ts'), true);
  assert.equal(inScope('apps/api/src/platform/tenantKind.ts'), true);
  assert.equal(inScope('packages/shared/src/permissions.ts'), true);
});

test('a rising count fails, with the file and line named', () => {
  const findings = scanSource(DOMAIN, "const a = 'chairman';\nconst b = 'chairman';\n");
  const entries = [{ file: DOMAIN, rule: 'chairman', count: 1, reason: 'fixture' }];
  const out = checkRoles({ findings, entries });
  assert.equal(out.problems.length, 2);
  assert.match(out.problems[0], /G10 roles .*fixture\.ts:1 chairman/);
  assert.deepEqual(out.notes, []);
});

test('a new file with a label fails even when the other files are baselined', () => {
  const findings = scanSource('apps/api/src/domains/new.ts', "const a = 'accountant';\n");
  const out = checkRoles({ findings, entries: [{ file: DOMAIN, rule: 'accountant', count: 3, reason: 'fixture' }] });
  assert.equal(out.problems.length, 1);
  assert.match(out.problems[0], /new\.ts:1 accountant/);
});

test('a falling count passes and reports stale as a note, not a failure', () => {
  const findings = scanSource(DOMAIN, "const a = 'chairman';\n");
  const entries = [{ file: DOMAIN, rule: 'chairman', count: 2, reason: 'fixture' }];
  const out = checkRoles({ findings, entries });
  assert.deepEqual(out.problems, []);
  assert.equal(out.notes.length, 1);
  assert.match(out.notes[0], /stale entry: .*chairman allows 2 but 1 found/);
  assert.equal(out.baselined, 1);
});

test('an allowance with no hits left is a note, and the file is clean', () => {
  const out = checkRoles({ findings: [], entries: [{ file: DOMAIN, rule: 'chairman', count: 1, reason: 'fixture' }] });
  assert.deepEqual(out.problems, []);
  assert.equal(out.notes.length, 1);
});
