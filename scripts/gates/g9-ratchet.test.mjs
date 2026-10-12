// G9 parts 1 (money) and 2 (IST period): ratchet scans. The fixtures name each
// pattern the draft lists, plus the look-alikes that must stay quiet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanSource, MONEY_RULES, IST_RULES } from './g9-ratchet.mjs';

const API = 'apps/api/src/domains/fixture.ts';

test('the money rules are the patterns the draft names', () => {
  assert.deepEqual(MONEY_RULES, ['round2(', 'Math.round(', 'Number.EPSILON', 'num(', 'Number(']);
});

test('the IST rules are the period getters the draft names', () => {
  assert.deepEqual(IST_RULES, ['.getUTCMonth()', '.getUTCFullYear()', '.getUTCDate()']);
});

test('flags each money pattern by its rule name', () => {
  const text = [
    'const a = round2(x);',
    'const b = Math.round(x);',
    'const c = x - Number.EPSILON;',
    'const d = num(x);',
    'const e = Number(x);',
    '',
  ].join('\n');
  assert.deepEqual(
    scanSource(API, text).map((f) => [f.line, f.rule]),
    [
      [1, 'round2('],
      [2, 'Math.round('],
      [3, 'Number.EPSILON'],
      [4, 'num('],
      [5, 'Number('],
    ],
  );
});

test('does not flag Number helpers that are not the bare conversion', () => {
  const text = 'const a = Number.parseFloat(s);\nconst b = Number.isInteger(n);\nconst c = Math.floor(x);\n';
  assert.deepEqual(scanSource(API, text), []);
});

test('flags each IST period getter', () => {
  const text = ['const m = d.getUTCMonth();', 'const y = d.getUTCFullYear();', 'const day = d.getUTCDate();', ''].join(
    '\n',
  );
  assert.deepEqual(
    scanSource(API, text).map((f) => [f.line, f.rule]),
    [
      [1, '.getUTCMonth()'],
      [2, '.getUTCFullYear()'],
      [3, '.getUTCDate()'],
    ],
  );
});

test('does not flag the local-time getters or getUTCHours', () => {
  const text = 'const m = d.getMonth();\nconst y = d.getFullYear();\nconst h = d.getUTCHours();\n';
  assert.deepEqual(scanSource(API, text), []);
});

test('exempts packages/shared/src/time.ts from the IST rules, which is where the helpers live', () => {
  const text = 'export const m = (d: Date) => d.getUTCMonth();\n';
  assert.deepEqual(scanSource('packages/shared/src/time.ts', text), []);
});

test('the time.ts exemption covers the IST rules only, not the money rules', () => {
  const found = scanSource('packages/shared/src/time.ts', 'const a = Math.round(x);\n');
  assert.deepEqual(
    found.map((f) => f.rule),
    ['Math.round('],
  );
});

test('ignores mentions in comments and strings', () => {
  const text = [
    '// round2(x) and d.getUTCMonth() were the old way',
    '/* Number.EPSILON */',
    'const s = "num(x) and Number(y)";',
    'const t = `${d.getUTCFullYear()}`;',
    '',
  ].join('\n');
  // The template literal's interpolation is code, so the getter inside it is
  // a real call and is the one finding this fixture is expected to produce.
  assert.deepEqual(
    scanSource(API, text).map((f) => f.rule),
    ['.getUTCFullYear()'],
  );
});

test('parses JSX in web sources', () => {
  const found = scanSource('apps/web/src/pages/fixture.tsx', 'export const C = () => <b>{Number(x)}</b>;\n');
  assert.deepEqual(
    found.map((f) => [f.file, f.rule]),
    [['apps/web/src/pages/fixture.tsx', 'Number(']],
  );
});
