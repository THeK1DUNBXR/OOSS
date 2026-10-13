// G2 (map freshness): docs/plan/MAP.md must match a regenerated map, or every
// session reads a stale index as if it were true (CI-GATES-DRAFT section 1, G2).
// This gate checks that the freshness check is wired: the `map:check` script runs
// genmap in check mode, the generator and the committed map exist, and the CI
// `static` job runs `pnpm map:check` as a live step. Regenerating the map is
// the CI step's job, not this gate's, so a stale map fails in that step.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readRepoText, jobsOf, runCommandsOf } from './ci-wiring.mjs';
import { REPO_ROOT } from './lib.mjs';

export const G2_JOB = 'static';
export const G2_SCRIPT = 'node scripts/genmap.mjs --check';
export const G2_STEP = 'pnpm map:check';
export const G2_GENERATOR = 'scripts/genmap.mjs';
export const G2_MAP = 'docs/plan/MAP.md';

/**
 * @param {{ pkg: { scripts?: Record<string, string> }, ciText: string | null, generatorExists: boolean, mapExists: boolean }} input
 * @returns {string[]}
 */
export function checkG2({ pkg, ciText, generatorExists, mapExists }) {
  const problems = [];
  const script = pkg?.scripts?.['map:check'];
  if (script !== G2_SCRIPT) {
    problems.push(`G2 package.json: "map:check" must be "${G2_SCRIPT}", found ${JSON.stringify(script ?? null)}.`);
  }
  if (!generatorExists) problems.push(`G2 ${G2_GENERATOR}: the map generator is missing.`);
  if (!mapExists) problems.push(`G2 ${G2_MAP}: the committed map is missing.`);

  if (ciText === null) {
    problems.push('G2 .github/workflows/ci.yml: the CI workflow is missing.');
    return problems;
  }
  const jobs = jobsOf(ciText);
  const inJob = jobs.has(G2_JOB) ? runCommandsOf(jobs.get(G2_JOB)) : [];
  if (!inJob.includes(G2_STEP)) {
    problems.push(`G2 .github/workflows/ci.yml: no live "${G2_STEP}" step in the "${G2_JOB}" job.`);
  }
  return problems;
}

export function runG2({ root = REPO_ROOT } = {}) {
  const pkg = JSON.parse(readRepoText('package.json', root));
  const problems = checkG2({
    pkg,
    ciText: readRepoText('.github/workflows/ci.yml', root),
    generatorExists: existsSync(join(root, G2_GENERATOR)),
    mapExists: existsSync(join(root, G2_MAP)),
  });
  return {
    id: 'G2',
    title: 'map freshness check wired (genmap --check)',
    problems,
    summary: problems.length === 0 ? 'map:check runs genmap --check in the static job' : 'not wired',
  };
}
