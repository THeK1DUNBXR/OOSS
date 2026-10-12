// G4 (mock scan): the API suite runs against real Postgres and real contexts.
// CLAUDE.md "Never": no mock in the API test suite. These cases plant the
// calls the scan must catch and the look-alikes it must leave alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanSource } from './g4-mock.mjs';

const TEST = 'apps/api/src/tests/fixture.test.ts';

test('flags vi.mock, vi.spyOn and vi.fn in a test file', () => {
  const text = [
    "vi.mock('../platform/db', () => ({}));",
    "vi.spyOn(ConsoleAdapter.prototype, 'send');",
    'const stub = vi.fn();',
    '',
  ].join('\n');
  const found = scanSource(TEST, text);
  assert.deepEqual(
    found.map((f) => [f.line, f.rule]),
    [
      [1, 'vi.mock'],
      [2, 'vi.spyOn'],
      [3, 'vi.fn'],
    ],
  );
});

test('flags jest.mock and jest.spyOn', () => {
  const text = "jest.mock('x');\nconst s = jest.spyOn(obj, 'm');\n";
  const found = scanSource('apps/api/src/tests/other.test.ts', text);
  assert.deepEqual(
    found.map((f) => [f.line, f.rule]),
    [
      [1, 'jest.mock'],
      [2, 'jest.spyOn'],
    ],
  );
});

test('reports file and line for each call', () => {
  const text = '\n\n  vi.mock("db");\n';
  const [hit] = scanSource(TEST, text);
  assert.equal(hit.file, TEST);
  assert.equal(hit.line, 3);
});

test('ignores mentions of a mock in comments and strings', () => {
  const text = [
    "// vi.mock('../platform/db') was the old way",
    '/* vi.spyOn(a, "b") */',
    'const note = "do not vi.fn() the database";',
    "const tmpl = `jest.mock('x')`;",
    '',
  ].join('\n');
  assert.deepEqual(scanSource(TEST, text), []);
});

test('ignores other vi helpers and calls on other receivers', () => {
  const text = ['vi.hoisted(() => 1);', 'mocker.mock("x");', 'obj.fn();', 'const v = vi.waitFor;', ''].join('\n');
  assert.deepEqual(scanSource(TEST, text), []);
});
