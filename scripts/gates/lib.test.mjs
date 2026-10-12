// Shared machinery: the test-file rule that every scan uses, and the ratchet
// that makes a baseline shrink-only. A ratchet that does not fail on a stale
// entry lets the list grow back, so the stale case is the one that matters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTestFile, checkRatchet, validateEntries } from './lib.mjs';

test('isTestFile recognises test files and test folders, and nothing else', () => {
  assert.equal(isTestFile('apps/api/src/tests/x.ts'), true);
  assert.equal(isTestFile('apps/api/src/platform/x.test.ts'), true);
  assert.equal(isTestFile('apps/web/src/a11y.test.tsx'), true);
  assert.equal(isTestFile('apps/web/src/x.spec.ts'), true);
  assert.equal(isTestFile('apps/api/src/platform/ledger.ts'), false);
  assert.equal(isTestFile('apps/api/src/contest/x.ts'), false);
});

const hit = (file, line, rule) => ({ file, line, rule, message: `${rule} here` });

test('a finding with no entry is a new problem and is named by file, line and rule', () => {
  const r = checkRatchet({ gate: 'G9', findings: [hit('a.ts', 4, 'round2(')], entries: [] });
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /a\.ts:4 round2\(/);
  assert.equal(r.baselined, 0);
});

test('findings equal to the entry count pass and count as baselined', () => {
  const r = checkRatchet({
    gate: 'G9',
    findings: [hit('a.ts', 1, 'num('), hit('a.ts', 2, 'num(')],
    entries: [{ file: 'a.ts', rule: 'num(', count: 2, reason: 'pre-existing' }],
  });
  assert.deepEqual(r.problems, []);
  assert.equal(r.baselined, 2);
});

test('more findings than the entry allows fail and name every location in that file and rule', () => {
  const r = checkRatchet({
    gate: 'G9',
    findings: [hit('a.ts', 1, 'num('), hit('a.ts', 2, 'num('), hit('a.ts', 3, 'num(')],
    entries: [{ file: 'a.ts', rule: 'num(', count: 2, reason: 'pre-existing' }],
  });
  assert.equal(r.problems.length, 3);
  assert.match(r.problems.join('\n'), /a\.ts:3 num\(/);
});

test('an entry the code no longer reaches is stale and fails, so the list can only shrink', () => {
  const r = checkRatchet({
    gate: 'G9',
    findings: [hit('a.ts', 1, 'num(')],
    entries: [{ file: 'a.ts', rule: 'num(', count: 2, reason: 'pre-existing' }],
  });
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /stale/);
  assert.match(r.problems[0], /a\.ts/);
});

test('an entry whose file has no hits at all is stale', () => {
  const r = checkRatchet({
    gate: 'G4',
    findings: [],
    entries: [{ file: 'gone.test.ts', rule: 'vi.spyOn', count: 1, reason: 'PENDING OWNER: example' }],
  });
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /stale/);
});

test('an entry with no reason, or a count that is not a positive integer, is invalid', () => {
  const problems = validateEntries([
    { file: 'a.ts', rule: 'num(', count: 1 },
    { file: 'b.ts', rule: 'num(', count: 0, reason: 'x' },
    { file: 'c.ts', rule: 'num(', count: 1.5, reason: 'x' },
    { file: 'd.ts', rule: 'num(', count: 1, reason: '   ' },
  ]);
  assert.equal(problems.length, 4);
});
