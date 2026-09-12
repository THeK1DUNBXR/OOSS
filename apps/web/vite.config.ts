import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The bundle says which build it is.
 *
 * Baked in at build time, because that is the only moment a bundle can know:
 * once it is a file on a CDN there is nothing to ask. This is what catches the
 * failure a screenshot cannot — a browser holding a bundle from before the fix,
 * against an API that has it.
 *
 * The sequence is the count of commits behind the build. It is the field worth
 * comparing at a glance: 148 is plainly later than 147, where two shas are just
 * two strings.
 */
function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

// The environment wins, for a container built from a copy of the source with no
// `.git` in it — which would otherwise report nothing, and a build that cannot
// say what it is is the problem this exists to solve.
const envSequence = Number(process.env.BUILD_SEQUENCE ?? '');
const sequence =
  Number.isFinite(envSequence) && envSequence > 0 ? envSequence : Number(git(['rev-list', '--count', 'HEAD']) ?? '0');
const commit = process.env.GIT_SHA?.slice(0, 7) ?? git(['rev-parse', '--short', 'HEAD']) ?? '';

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD__: JSON.stringify({
      sequence: Number.isFinite(sequence) ? sequence : 0,
      commit,
      builtAt: new Date().toISOString(),
      known: Boolean(commit) || sequence > 0,
    }),
  },
  server: {
    port: 5173,
    host: true,
    proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: true } },
  },
});
