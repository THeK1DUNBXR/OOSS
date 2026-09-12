/**
 * What build this is.
 *
 * There is a failure this platform produced twice in one week, and both times
 * it cost an hour before anybody suspected it: the code was right and the thing
 * running was not. Once it was a web bundle from before a fix; once it was a
 * tenant whose navigation rows had never been re-seeded, so the sidebar went on
 * answering with vocabulary that had been replaced. Neither is visible from the
 * screen. You cannot tell a stale build from a wrong one by looking at it.
 *
 * So the product says what it is, in a footnote on every screen, and the number
 * it leads with is a **sequence**: the count of commits behind this build. A
 * sequence is the thing a person can actually compare — 148 is plainly later
 * than 147, where `7ab59ff` and `035870e` are just two strings. The commit is
 * printed beside it for anybody who needs to look it up.
 *
 * Three stamps, because there are three things that can be stale independently:
 * the API, the web bundle, and the tenant's seeded data.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BuildStamp {
  /** From package.json. Changes rarely; here because a release has a name. */
  version: string;
  /**
   * Commits behind this build. Monotonic, and the only field worth comparing at
   * a glance. `0` when it could not be determined — see `known`.
   */
  sequence: number;
  /** Short commit sha, for looking the build up. */
  commit: string;
  /** When it was built, where a build step said so. */
  builtAt: string | null;
  /** False when nothing could be resolved: a footnote that says so beats one that guesses. */
  known: boolean;
}

const here = dirname(fileURLToPath(import.meta.url));

function fromGit(args: string[]): string | null {
  try {
    // Runs where the repository is; absent in a built container, which is
    // exactly why the environment variables come first.
    return execFileSync('git', args, { cwd: here, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function packageVersion(): string {
  for (const path of [join(here, '../../package.json'), join(here, '../../../package.json')]) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: string };
      if (parsed.version) return parsed.version;
    } catch {
      /* try the next one */
    }
  }
  return '0.0.0';
}

/**
 * Resolved once, at boot.
 *
 * The environment wins over git, because a container built from a copy of the
 * source has no `.git` and would otherwise report nothing — and a build that
 * cannot say what it is is the problem this file exists to solve. A build step
 * sets `BUILD_SEQUENCE`, `GIT_SHA` and `BUILT_AT`; a developer running from a
 * checkout gets the same answer from git without setting anything.
 */
function resolve(): BuildStamp {
  const envSequence = Number(process.env.BUILD_SEQUENCE ?? '');
  const sequence = Number.isFinite(envSequence) && envSequence > 0
    ? envSequence
    : Number(fromGit(['rev-list', '--count', 'HEAD']) ?? '0');

  const commit = process.env.GIT_SHA?.slice(0, 7) ?? fromGit(['rev-parse', '--short', 'HEAD']) ?? '';

  return {
    version: packageVersion(),
    sequence: Number.isFinite(sequence) ? sequence : 0,
    commit,
    builtAt: process.env.BUILT_AT ?? null,
    known: Boolean(commit) || sequence > 0,
  };
}

export const BUILD: BuildStamp = resolve();

/** When this process started. A restart is a thing people need to see. */
export const STARTED_AT = new Date().toISOString();

/** `148 · 7ab59ff`, or `unknown build` when it could not be resolved. */
export function buildLabel(stamp: BuildStamp = BUILD): string {
  if (!stamp.known) return 'unknown build';
  return [stamp.sequence > 0 ? String(stamp.sequence) : null, stamp.commit || null]
    .filter(Boolean)
    .join(' · ');
}
