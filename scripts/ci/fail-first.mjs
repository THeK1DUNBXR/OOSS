/**
 * Failing-test-first gate (G6; CI-GATES-DRAFT.md section 5, question 3).
 *
 * CLAUDE.md "Working" says a defect is not fixed until a test exists that fails
 * on the old code. The owner's answer is a proof in the history: a red commit,
 * placed before the fix, whose message names its test file with
 * `Red-Test: <path>`. CI replays that commit's parent with only the named test
 * files overlaid. Those files must fail there and pass at the head.
 *
 * The earlier design checked that a test's name contained the FX id. A name
 * says nothing about whether the test ever failed, so that gate could be met by
 * a test written after the fix. The trailer makes CI run the old code itself.
 *
 * The decisions (trailer parsing, the requirement, the plan) are pure exports.
 * The CLI shells out to git and to the test runner.
 *
 * Limits, accepted on purpose:
 *   - node_modules is linked from the checkout, so the old-code run uses the
 *     head's dependencies and its built workspace packages. A red test that
 *     fails only because a dependency or a workspace package changed is not
 *     distinguished from one that fails because of the fix.
 *   - The database is the head's schema, so an old-code run is not against the
 *     old schema. A red test that depends on a migration cannot be proven red.
 *   - apps/api tests run under vitest, everything else under node:test.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RED_TEST_TRAILER = 'Red-Test';
export const OPT_IN_LABEL = 'needs-red-test';

const FX_ID = /\bFX-\d+\b/;
const FIX_SUBJECT = /^fix(\(|:)/;
const TEST_FILE = /\.test\.(mjs|js|ts|tsx)$/;
// Vitest says this when a path matches no include glob; node:test says it when
// a file holds no tests. Either way the file did not run, so nothing was proven.
const NO_TESTS = /No test files found|# tests 0\b/;

/** The last paragraph of a message, which is where git reads trailers from. A subject with no body has none. */
export function trailerBlock(message) {
  const paragraphs = String(message)
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n\s*\n/);
  return paragraphs.length > 1 ? paragraphs.at(-1) : '';
}

/** Why a Red-Test path is unacceptable, or null when it is fine. */
export function checkTestPath(path) {
  if (isAbsolute(path) || path.startsWith('\\')) return 'must be repository-relative';
  if (/[\s,]/.test(path)) return 'must name one path, with no spaces or commas (repeat the trailer for more files)';
  if (posix.normalize(path).split('/').includes('..')) return 'must not leave the repository';
  if (!TEST_FILE.test(path)) return 'must name a test file (*.test.mjs, *.test.js, *.test.ts or *.test.tsx)';
  return null;
}

/** Red-Test trailers in a commit message: the valid paths, and every line that tried and failed. */
export function parseRedTestTrailers(message) {
  const paths = [];
  const malformed = [];
  for (const line of trailerBlock(message).split('\n')) {
    if (!/^red-test\b/i.test(line)) continue;
    const match = /^Red-Test:[ \t]+(\S.*?)[ \t]*$/i.exec(line);
    const problem = match ? checkTestPath(match[1]) : 'expected "Red-Test: <path>"';
    if (problem) {
      malformed.push({ line, reason: problem });
      continue;
    }
    const path = posix.normalize(match[1]);
    if (!paths.includes(path)) paths.push(path);
  }
  return { paths, malformed };
}

/** Whether this PR must contain at least one red commit, and the triggers that say so. */
export function requirement({ title = '', subjects = [], labels = [] }) {
  const reasons = [];
  const titleId = FX_ID.exec(title);
  if (titleId) reasons.push(`PR title cites ${titleId[0]}`);
  for (const subject of subjects) {
    const id = FX_ID.exec(subject);
    if (id) reasons.push(`commit subject cites ${id[0]}: ${subject}`);
  }
  for (const subject of subjects) {
    if (FIX_SUBJECT.test(subject)) reasons.push(`commit subject is a fix: ${subject}`);
  }
  if (labels.includes(OPT_IN_LABEL)) reasons.push(`label ${OPT_IN_LABEL}`);
  return { required: reasons.length > 0, reasons };
}

/**
 * The plan for one PR. `commits` is the range merge-base..HEAD, oldest first,
 * each as { sha, parent, subject, message }. `filesAt(sha)` lists the paths in a
 * commit; when given, every named test file must be among them.
 */
export function buildPlan({ title = '', labels = [], commits, filesAt }) {
  const need = requirement({ title, subjects: commits.map((c) => c.subject), labels });
  const errors = [];
  const redCommits = [];

  for (const commit of commits) {
    const { paths, malformed } = parseRedTestTrailers(commit.message);
    for (const bad of malformed) {
      errors.push(`${short(commit.sha)}: malformed trailer "${bad.line}": ${bad.reason}`);
    }
    if (paths.length === 0) continue;

    const present = filesAt ? new Set(filesAt(commit.sha)) : null;
    for (const path of paths) {
      if (present && !present.has(path)) {
        errors.push(`${short(commit.sha)}: named test file ${path} does not exist in this commit`);
      }
    }
    redCommits.push({ sha: commit.sha, parent: commit.parent, subject: commit.subject, paths });
  }

  if (need.required && redCommits.length === 0) {
    errors.push(
      `this PR requires a red test (${need.reasons.join('; ')}) but no commit in the range carries a ${RED_TEST_TRAILER} trailer`,
    );
  }

  const notices = [];
  if (!need.required && redCommits.length === 0) {
    notices.push(
      `failing-test-first not required: no FX id in the title or commit subjects, no fix commit, no ${OPT_IN_LABEL} label`,
    );
  }

  return { required: need.required, reasons: need.reasons, redCommits, errors, notices };
}

/** The test runner for one file when none is injected: vitest for the API, node:test elsewhere. */
export function runnerFor(path) {
  if (path.startsWith('apps/api/')) return ['pnpm', '--filter', '@kaizen/api', 'exec', 'vitest', 'run'];
  return ['node', '--test'];
}

/** `git log` output in the format readRange requests, parsed into commits. */
export function parseLog(text) {
  return text
    .split('\x1e')
    .map((record) => record.replace(/^\n+/, ''))
    .filter((record) => record.trim() !== '')
    .map((record) => {
      const [sha, parents, subject, ...rest] = record.split('\x1f');
      return { sha, parent: parents.split(' ')[0] || null, subject, message: rest.join('\x1f') };
    });
}

export function parseLabels(text) {
  const value = JSON.parse(text);
  if (!Array.isArray(value) || !value.every((label) => typeof label === 'string')) {
    throw new Error('--labels must be a JSON array of strings');
  }
  return value;
}

const FLAGS = new Map([
  ['--base', 'base'],
  ['--title', 'title'],
  ['--labels', 'labels'],
  ['--repo', 'repo'],
  ['--runner', 'runner'],
]);

export function parseArgs(argv) {
  const opts = { base: '', title: '', labels: '[]', repo: '.', runner: '' };
  for (let i = 0; i < argv.length; i += 2) {
    const key = FLAGS.get(argv[i]);
    if (!key) throw new Error(`unknown argument ${argv[i]}`);
    if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`);
    opts[key] = argv[i + 1];
  }
  if (!opts.base) throw new Error('--base is required');
  return opts;
}

const short = (sha) => String(sha).slice(0, 7);

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function gitBytes(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { maxBuffer: 64 * 1024 * 1024 });
}

function readRange(repo, mergeBase) {
  const log = git(repo, ['log', '--reverse', '--format=%H%x1f%P%x1f%s%x1f%B%x1e', `${mergeBase}..HEAD`]);
  return parseLog(log);
}

function filesAt(repo, sha) {
  return git(repo, ['ls-tree', '-r', '--name-only', sha]).split('\n').filter(Boolean);
}

/** Link every node_modules in the checkout into the old-code tree, so the old tree can run the same runner. */
function linkDependencies(repo, tree, links) {
  const roots = [''];
  for (const group of ['apps', 'packages']) {
    const dir = join(repo, group);
    if (existsSync(dir)) for (const name of readdirSync(dir)) roots.push(join(group, name));
  }
  for (const rel of roots) {
    const source = join(repo, rel, 'node_modules');
    if (!existsSync(source)) continue;
    const target = join(tree, rel, 'node_modules');
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(source, target, 'dir');
    links.push(target);
  }
}

/**
 * Runs `use` in a worktree of the red commit's parent, with the red commit's
 * named test files written over it. The worktree and its links are removed after.
 */
function withOldCode(repo, red, use) {
  if (!red.parent) throw new Error(`commit ${short(red.sha)} has no parent to run the old code from`);
  const dir = mkdtempSync(join(tmpdir(), 'fail-first-'));
  const tree = join(dir, 'old');
  const links = [];
  try {
    git(repo, ['worktree', 'add', '--detach', '-q', tree, red.parent]);
    linkDependencies(repo, tree, links);
    for (const path of red.paths) {
      const body = gitBytes(repo, ['show', `${red.sha}:${path}`]);
      mkdirSync(dirname(join(tree, path)), { recursive: true });
      writeFileSync(join(tree, path), body);
    }
    return use(tree);
  } finally {
    for (const link of links) unlinkSync(link);
    try {
      git(repo, ['worktree', 'remove', '--force', tree]);
    } catch {
      // Removed with the directory below if git refused.
    }
    try {
      git(repo, ['worktree', 'prune']);
    } catch {
      // Nothing to prune.
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * One test file under its runner. NODE_TEST_CONTEXT is removed: a `node --test`
 * started inside another one inherits it and then reports its failures to the
 * parent instead of through its exit code, which made a failing red test look
 * like a passing one when this gate ran under node:test.
 */
function runOne(override, file, cwd) {
  const argv = override ?? runnerFor(file);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(argv[0], [...argv.slice(1), join(cwd, file)], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return { passed: result.status === 0, ran: !NO_TESTS.test(output), output };
}

function lastLines(text, count = 25) {
  return text.trimEnd().split('\n').slice(-count).join('\n');
}

export function main(argv) {
  let opts;
  let labels;
  try {
    opts = parseArgs(argv);
    labels = parseLabels(opts.labels);
  } catch (error) {
    console.error(`fail-first: ${error.message}`);
    return 2;
  }

  const repo = resolve(opts.repo);
  const override = opts.runner.trim() ? opts.runner.trim().split(/\s+/) : null;
  const mergeBase = git(repo, ['merge-base', opts.base, 'HEAD']).trim();
  const commits = readRange(repo, mergeBase);
  const plan = buildPlan({ title: opts.title, labels, commits, filesAt: (sha) => filesAt(repo, sha) });

  for (const note of plan.notices) console.log(`notice: ${note}`);
  // Structural errors (bad trailer, missing file, no red commit where one is
  // required) stop the run before any test runs: a named file that does not
  // exist cannot be checked against either side.
  if (plan.errors.length > 0) {
    for (const error of plan.errors) console.error(`fail-first: ${error}`);
    return 1;
  }

  const problems = [];
  const headChecked = new Set();

  for (const red of plan.redCommits) {
    const label = `${short(red.sha)} "${red.subject}"`;
    withOldCode(repo, red, (tree) => {
      for (const file of red.paths) {
        const run = runOne(override, file, tree);
        if (!run.ran) {
          problems.push(`${file} did not run on the old code (commit ${label}); a red test has to run to be red`);
        } else if (run.passed) {
          problems.push(`red test passes on old code: ${file} (commit ${label})`);
        } else {
          console.log(`ok: ${file} fails on old code (commit ${label})`);
        }
      }
    });

    for (const file of red.paths) {
      if (headChecked.has(file)) continue;
      headChecked.add(file);
      const run = runOne(override, file, repo);
      if (run.passed && run.ran) {
        console.log(`ok: ${file} passes at head`);
      } else {
        problems.push(
          `${file} does not pass at head (commit ${label}); the fix has to make the red test pass\n${lastLines(run.output)}`,
        );
      }
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`fail-first: ${problem}`);
    return 1;
  }
  if (plan.redCommits.length > 0) console.log(`fail-first: ${plan.redCommits.length} red commit(s) checked`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
