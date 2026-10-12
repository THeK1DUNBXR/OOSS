// Tests for the failing-test-first gate (G6). The unit cases exercise the pure
// decision functions. The integration cases build a throwaway git repository
// and run the real CLI against it with node:test as the runner, so they need
// git and nothing else: no Postgres, no vitest.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildPlan, parseLabels, parseRedTestTrailers, requirement, runnerFor } from './fail-first.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'fail-first.mjs');
const msg = (subject, ...body) => [subject, '', ...body].join('\n');

describe('parseRedTestTrailers', () => {
  test('reads one trailer', () => {
    const r = parseRedTestTrailers(msg('test: value', 'Red-Test: apps/api/src/tests/a.test.ts'));
    assert.deepEqual(r, { paths: ['apps/api/src/tests/a.test.ts'], malformed: [] });
  });

  test('reads several trailers in order and drops a repeat', () => {
    const r = parseRedTestTrailers(
      msg('test: value', 'Red-Test: a.test.ts', 'Red-Test: b.test.mjs', 'Red-Test: a.test.ts'),
    );
    assert.deepEqual(r, { paths: ['a.test.ts', 'b.test.mjs'], malformed: [] });
  });

  test('a message with no Red-Test trailer has none', () => {
    assert.deepEqual(parseRedTestTrailers(msg('test: value', 'Co-Authored-By: someone')), { paths: [], malformed: [] });
  });

  test('a subject-only message is not read as a trailer block', () => {
    assert.deepEqual(parseRedTestTrailers('Red-Test: a.test.ts'), { paths: [], malformed: [] });
  });

  test('a trailer that is not in the last paragraph is not read', () => {
    const r = parseRedTestTrailers(msg('test: value', 'Red-Test: a.test.ts', '', 'Later prose, not a trailer.'));
    assert.deepEqual(r, { paths: [], malformed: [] });
  });

  test('the key is read case-insensitively', () => {
    assert.deepEqual(parseRedTestTrailers(msg('test: value', 'red-test: a.test.ts')).paths, ['a.test.ts']);
  });

  test('malformed trailers are reported, not skipped', () => {
    const bad = [
      'Red-Test:',
      'Red-Test: /abs/a.test.ts',
      'Red-Test: ../elsewhere/a.test.ts',
      'Red-Test: src/value.mjs',
      'Red-Test: a.test.ts, b.test.ts',
      'Red-Test a.test.ts',
    ];
    for (const line of bad) {
      const r = parseRedTestTrailers(msg('test: value', line));
      assert.equal(r.malformed.length, 1, `expected ${line} to be malformed`);
      assert.deepEqual(r.paths, [], `expected ${line} to yield no path`);
    }
  });

  test('one malformed trailer does not hide a valid one beside it', () => {
    const r = parseRedTestTrailers(msg('test: value', 'Red-Test: src/value.mjs', 'Red-Test: a.test.ts'));
    assert.deepEqual(r.paths, ['a.test.ts']);
    assert.equal(r.malformed.length, 1);
  });
});

describe('requirement', () => {
  test('an FX id in the PR title requires a red test', () => {
    assert.equal(requirement({ title: 'Fix rounding (FX-12)', subjects: ['chore: x'] }).required, true);
  });

  test('an FX id in a commit subject requires a red test', () => {
    assert.equal(requirement({ title: 'Cleanup', subjects: ['chore: close FX-7'] }).required, true);
  });

  test('an FX id must be a whole word', () => {
    assert.equal(requirement({ title: 'PREFX-12 cleanup', subjects: ['chore: x'] }).required, false);
  });

  test('a fix( or fix: commit subject requires a red test', () => {
    assert.equal(requirement({ subjects: ['fix(ledger): round half up'] }).required, true);
    assert.equal(requirement({ subjects: ['fix: round half up'] }).required, true);
  });

  test('fixup and fixture subjects do not', () => {
    assert.equal(requirement({ subjects: ['fixup! earlier commit', 'fixture: seed rows'] }).required, false);
  });

  test('the needs-red-test label requires a red test', () => {
    assert.equal(requirement({ labels: ['needs-red-test'] }).required, true);
  });

  test('nothing matching means no requirement and no reasons', () => {
    assert.deepEqual(requirement({ title: 'Docs', subjects: ['docs: tidy'], labels: ['docs'] }), {
      required: false,
      reasons: [],
    });
  });

  test('every trigger that fires is named in the reasons', () => {
    const r = requirement({ title: 'FX-3', subjects: ['fix: x'], labels: ['needs-red-test'] });
    assert.equal(r.reasons.length, 3);
  });
});

describe('buildPlan', () => {
  const commit = (sha, subject, body = []) => ({
    sha,
    parent: `parent-of-${sha}`,
    subject,
    message: msg(subject, ...body),
  });

  test('a valid red commit is planned with its parent and its paths', () => {
    const commits = [
      commit('a1', 'test: red', ['Red-Test: apps/api/src/tests/a.test.ts']),
      commit('b2', 'fix: value (FX-3)'),
    ];
    const plan = buildPlan({
      title: 'Fix value (FX-3)',
      commits,
      filesAt: (sha) => (sha === 'a1' ? ['apps/api/src/tests/a.test.ts'] : []),
    });
    assert.deepEqual(plan.errors, []);
    assert.equal(plan.required, true);
    assert.deepEqual(plan.redCommits, [
      { sha: 'a1', parent: 'parent-of-a1', subject: 'test: red', paths: ['apps/api/src/tests/a.test.ts'] },
    ]);
  });

  test('a required PR with no red commit is an error', () => {
    const plan = buildPlan({ title: 'Fix value (FX-3)', commits: [commit('c3', 'fix: value')] });
    assert.equal(plan.errors.length, 1);
    assert.match(plan.errors[0], /requires a red test/);
  });

  test('a PR that needs no red test passes with a notice', () => {
    const plan = buildPlan({ title: 'Update docs', commits: [commit('d4', 'docs: tidy')] });
    assert.deepEqual(plan.errors, []);
    assert.deepEqual(plan.redCommits, []);
    assert.equal(plan.required, false);
    assert.equal(plan.notices.length, 1);
  });

  test('a named test file missing from its commit is an error', () => {
    const plan = buildPlan({
      title: 'Fix value (FX-3)',
      commits: [commit('a1', 'test: red', ['Red-Test: apps/api/src/tests/a.test.ts']), commit('b2', 'fix: value')],
      filesAt: () => [],
    });
    assert.equal(plan.errors.length, 1);
    assert.match(plan.errors[0], /does not exist in this commit/);
  });

  test('a malformed trailer is an error and the valid paths in that commit are still planned', () => {
    const plan = buildPlan({
      title: 'Fix value (FX-3)',
      commits: [commit('a1', 'test: red', ['Red-Test: src/value.mjs', 'Red-Test: a.test.ts'])],
      filesAt: () => ['a.test.ts'],
    });
    assert.equal(plan.errors.length, 1);
    assert.match(plan.errors[0], /malformed trailer/);
    assert.deepEqual(
      plan.redCommits.map((c) => c.paths),
      [['a.test.ts']],
    );
  });

  test('red commits stay in range order', () => {
    const plan = buildPlan({
      title: 'Fix value (FX-3)',
      commits: [
        commit('a1', 'test: first', ['Red-Test: one.test.mjs']),
        commit('b2', 'test: second', ['Red-Test: two.test.mjs']),
      ],
    });
    assert.deepEqual(
      plan.redCommits.map((c) => c.sha),
      ['a1', 'b2'],
    );
  });
});

describe('runnerFor', () => {
  test('API tests run under vitest from the API package', () => {
    const argv = runnerFor('apps/api/src/tests/a.test.ts');
    assert.ok(argv.includes('vitest'));
    assert.ok(argv.includes('@kaizen/api'));
  });

  test('other test files run under node:test', () => {
    assert.deepEqual(runnerFor('scripts/ci/fail-first.test.mjs'), ['node', '--test']);
  });
});

describe('parseLabels', () => {
  test('reads a JSON array of label names', () => {
    assert.deepEqual(parseLabels('["needs-red-test","docs"]'), ['needs-red-test', 'docs']);
  });

  test('refuses anything that is not an array of strings', () => {
    assert.throws(() => parseLabels('{"a":1}'));
    assert.throws(() => parseLabels('[1]'));
    assert.throws(() => parseLabels('not json'));
  });
});

describe('the CLI against a throwaway repository', () => {
  const scratch = [];
  after(() => {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  });

  const git = (repo, args) =>
    execFileSync(
      'git',
      [
        '-C',
        repo,
        '-c',
        'user.name=gate',
        '-c',
        'user.email=gate@example.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { encoding: 'utf8' },
    ).trim();

  function newRepo() {
    const dir = mkdtempSync(join(tmpdir(), 'fail-first-repo-'));
    scratch.push(dir);
    git(dir, ['init', '-q']);
    return dir;
  }

  function commitFiles(repo, subject, files = {}, body = []) {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), content);
    }
    git(repo, ['add', '-A']);
    git(repo, ['commit', '--allow-empty', '-q', '-m', msg(subject, ...body)]);
    return git(repo, ['rev-parse', 'HEAD']);
  }

  // A node:test file that imports the value under test and asserts on it.
  const valueTest = (expected) =>
    [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { value } from '../src/value.mjs';",
      '',
      `test('value', () => assert.equal(value, ${expected}));`,
      '',
    ].join('\n');

  const cli = (repo, base) =>
    spawnSync(
      process.execPath,
      [CLI, '--repo', repo, '--base', base, '--title', 'Fix value (FX-1)', '--labels', '[]', '--runner', 'node --test'],
      { encoding: 'utf8' },
    );

  test('a red test that fails on the old code and passes at head is accepted', () => {
    const repo = newRepo();
    const base = commitFiles(repo, 'chore: base', { 'src/value.mjs': 'export const value = 1;\n' });
    commitFiles(repo, 'test: value is two (FX-1)', { 'tests/value.test.mjs': valueTest(2) }, [
      'Red-Test: tests/value.test.mjs',
    ]);
    commitFiles(repo, 'fix: value is two (FX-1)', { 'src/value.mjs': 'export const value = 2;\n' });

    const run = cli(repo, base);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /fails on old code/);
  });

  test('a red test that passes on the old code fails the gate', () => {
    const repo = newRepo();
    const base = commitFiles(repo, 'chore: base', { 'src/value.mjs': 'export const value = 1;\n' });
    commitFiles(repo, 'test: value is one (FX-1)', { 'tests/value.test.mjs': valueTest(1) }, [
      'Red-Test: tests/value.test.mjs',
    ]);
    commitFiles(repo, 'fix: value (FX-1)', { 'src/value.mjs': 'export const value = 2;\n' });

    const run = cli(repo, base);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /red test passes on old code/);
  });

  test('a Red-Test trailer naming a file the commit does not contain fails the gate', () => {
    const repo = newRepo();
    const base = commitFiles(repo, 'chore: base', { 'src/value.mjs': 'export const value = 1;\n' });
    commitFiles(repo, 'test: value is two (FX-1)', {}, ['Red-Test: tests/missing.test.mjs']);
    commitFiles(repo, 'fix: value is two (FX-1)', { 'src/value.mjs': 'export const value = 2;\n' });

    const run = cli(repo, base);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /does not exist in this commit/);
  });
});
