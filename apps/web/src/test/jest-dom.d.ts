// Teaches vitest's `expect` the jest-dom matchers (toBeInTheDocument and the
// rest). setup.ts registers them at runtime; this registers them for the type
// checker, which the package's own vitest typings do not reach from here.
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

declare module 'vitest' {
  // These interfaces exist only to merge the matchers into vitest's own, so
  // having no members of their own is the point, not an empty type.
  /* eslint-disable @typescript-eslint/no-empty-object-type */
  interface Assertion<T> extends TestingLibraryMatchers<unknown, T> {}
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<unknown, unknown> {}
  /* eslint-enable @typescript-eslint/no-empty-object-type */
}
