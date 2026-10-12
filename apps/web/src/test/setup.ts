import * as matchers from '@testing-library/jest-dom/matchers';
import { cleanup } from '@testing-library/react';
import { afterEach, expect, vi } from 'vitest';

expect.extend(matchers);

// jsdom has no canvas. axe-core probes a canvas for icon ligatures while it
// checks colour contrast, and jsdom answers that probe by logging "not
// implemented" for every element. Returning null tells axe there is no canvas,
// so contrast is reported as incomplete, which is what jsdom can honestly say.
vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);

// Vitest runs without globals, so Testing Library cannot register its own
// cleanup. Without this, one test's DOM leaks into the next one's queries.
afterEach(() => {
  cleanup();
});
