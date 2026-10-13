// Reads the parts of the CI workflows that G1 to G3 check: which jobs exist, and
// which run steps each job runs. A line-based reader, not a YAML parser: the
// workflow files here use two-space job keys under `jobs:` and `- run:` steps, and
// a comment never counts as a step (a step that is commented out does not run).
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './lib.mjs';

export const WORKFLOW_DIR = '.github/workflows';

/** Job name -> the raw lines of that job's block, from the `jobs:` key down. */
export function jobsOf(yamlText) {
  const lines = yamlText.split('\n');
  const jobs = new Map();
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (start < 0) return jobs;
  let current = null;
  for (const line of lines.slice(start + 1)) {
    const key = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (key) {
      current = key[1];
      jobs.set(current, []);
      continue;
    }
    if (/^\S/.test(line)) break;
    if (current) jobs.get(current).push(line);
  }
  return jobs;
}

/** The command of each live `- run:` step in a job, trimmed. A commented-out step is not a step. */
export function runCommandsOf(jobLines) {
  const commands = [];
  for (const raw of jobLines) {
    const line = raw.trim();
    if (line.startsWith('#')) continue;
    const match = /^(?:-\s*)?run:\s*(.+?)\s*$/.exec(line);
    if (match) commands.push(match[1]);
  }
  return commands;
}

/** The live `KEY:` lines of a job's env block, as names. A key in a comment does not count. */
export function envKeysOf(jobLines) {
  const keys = [];
  for (const raw of jobLines) {
    const line = raw.trim();
    if (line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*):\s*\S/.exec(line);
    if (match) keys.push(match[1]);
  }
  return keys;
}

/** Reads a repo file as text, or null when it does not exist. */
export function readRepoText(rel, root = REPO_ROOT) {
  const full = join(root, rel);
  return existsSync(full) ? readFileSync(full, 'utf8') : null;
}

/** Repo-relative paths of every file in a repo directory, or [] when it does not exist. */
export function listRepoFiles(rel, root = REPO_ROOT) {
  const full = join(root, rel);
  return existsSync(full) ? readdirSync(full) : [];
}

/** Every workflow file, as { rel, text }, in name order. */
export function readWorkflows(root = REPO_ROOT) {
  return listRepoFiles(WORKFLOW_DIR, root)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
    .map((name) => ({ rel: `${WORKFLOW_DIR}/${name}`, text: readRepoText(`${WORKFLOW_DIR}/${name}`, root) }));
}
