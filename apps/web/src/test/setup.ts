import * as matchers from '@testing-library/jest-dom/matchers';
import { cleanup } from '@testing-library/react';
import { afterEach, expect } from 'vitest';

expect.extend(matchers);

// Vitest runs without globals, so Testing Library cannot register its own
// cleanup. Without this, one test's DOM leaks into the next one's queries.
afterEach(() => {
  cleanup();
});
