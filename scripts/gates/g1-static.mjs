// G1 (static checks): typecheck, lint and the Tailwind token check run on every
// change (CI-GATES-DRAFT section 1, G1). This gate checks that they are wired:
// the scripts exist and lint still runs the token check, and the CI `static` job
// runs typecheck and lint as live steps. It does not run tsc or eslint. The
// `static` job runs them, and a job that is merely listed would otherwise pass here.
import { readRepoText, jobsOf, runCommandsOf } from './ci-wiring.mjs';
import { REPO_ROOT } from './lib.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const G1_JOB = 'static';
export const G1_STEPS = ['pnpm typecheck', 'pnpm lint'];
export const G1_LINT_PARTS = ['eslint .', 'node scripts/check-tailwind-tokens.mjs --check'];
export const G1_TOKEN_SCRIPT = 'scripts/check-tailwind-tokens.mjs';

/**
 * @param {{ pkg: { scripts?: Record<string, string> }, ciText: string | null, tokenScriptExists: boolean }} input
 * @returns {string[]} one line per problem, naming the file and the rule
 */
export function checkG1({ pkg, ciText, tokenScriptExists }) {
  const problems = [];
  const scripts = pkg?.scripts ?? {};
  if (!scripts.typecheck) problems.push('G1 package.json: no "typecheck" script.');
  const lint = scripts.lint ?? '';
  for (const part of G1_LINT_PARTS) {
    if (!lint.includes(part)) problems.push(`G1 package.json: the "lint" script no longer runs "${part}".`);
  }
  if (!tokenScriptExists) problems.push(`G1 ${G1_TOKEN_SCRIPT}: the Tailwind token check script is missing.`);

  if (ciText === null) {
    problems.push('G1 .github/workflows/ci.yml: the CI workflow is missing.');
    return problems;
  }
  const jobs = jobsOf(ciText);
  const steps = jobs.has(G1_JOB) ? runCommandsOf(jobs.get(G1_JOB)) : null;
  if (steps === null) {
    problems.push(`G1 .github/workflows/ci.yml: no "${G1_JOB}" job runs the static checks.`);
    return problems;
  }
  for (const step of G1_STEPS) {
    if (!steps.includes(step)) problems.push(`G1 .github/workflows/ci.yml: job "${G1_JOB}" does not run "${step}".`);
  }
  return problems;
}

export function runG1({ root = REPO_ROOT } = {}) {
  const pkg = JSON.parse(readRepoText('package.json', root));
  const problems = checkG1({
    pkg,
    ciText: readRepoText('.github/workflows/ci.yml', root),
    tokenScriptExists: existsSync(join(root, G1_TOKEN_SCRIPT)),
  });
  return {
    id: 'G1',
    title: 'static checks wired: typecheck, lint, Tailwind tokens',
    problems,
    summary: problems.length === 0 ? 'typecheck, lint and token check are wired into the static job' : 'not wired',
  };
}
