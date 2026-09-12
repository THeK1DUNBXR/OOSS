/**
 * Lint, deliberately narrow.
 *
 * There was no ESLint configuration in this repository at all.
 *
 * The unknown-Tailwind-token check the plan asks for lives in
 * `scripts/check-tailwind-tokens.mjs` instead of here — see the reasoning in
 * that file's header; `eslint-plugin-tailwindcss` cannot load under this
 * workspace's pnpm layout.
 *
 * The rule set is small on purpose. A maximal config on a codebase this size
 * produces several hundred findings, and a lint step that everybody runs with
 * `--no-verify` protects nothing. What is here is what has already cost the
 * project something, plus the correctness rules that cannot be argued with.
 * Tighten it per phase — Phase 4.1 turns `no-explicit-any` into an error for
 * `apps/web` once the typed client exists and there is something to point at.
 */

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.wrangler/**',
      'apps/web/public/**',
      'packages/*/dist/**',
      'docs/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      // The codebase leans on `_unused` destructuring to drop fields; that is
      // a deliberate idiom here, not an oversight.
      /**
       * Warn, not error, and deliberately so. There are 54 today and they are
       * real dead code — but a good number are `const auth = currentAuth()`,
       * which looks unused and is not: `currentAuth()` throws when there is no
       * request context, so the line is an implicit assertion. Deleting them
       * blind would change behaviour in the write paths. They need clearing one
       * at a time, with judgement, which is a task and not a lint autofix.
       */
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // 114 occurrences today. Real, worth fixing, and not worth blocking a
      // build on until Phase 4.1 generates the client that replaces them.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
      // An `await` that was meant to be there and is not is a race, and this
      // codebase is full of async write paths.
      'require-await': 'off',
      'no-constant-condition': ['error', { checkLoops: false }],
    },
  },

  // ---------------------------------------------------------------------
  // Node contexts
  // ---------------------------------------------------------------------
  {
    files: ['apps/api/**/*.ts', 'packages/**/*.ts', 'scripts/**/*.mjs', 'worker/**/*.ts', 'e2e/**/*.ts'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly', __dirname: 'readonly' },
    },
  },

  // Tests say what they mean; the strictness that helps production code gets
  // in the way of a fixture.
  {
    files: ['**/*.test.ts', 'e2e/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
