/**
 * L2, migration equivalence (CI-GATES-DRAFT L2; ORDERED-PLAN 1.5).
 *
 * This test runs the L2 harness on a local spreadsheet fixture. The fixture is test data, not a ledger
 * to act on, and it may carry personal-looking data, so it is kept out of git. L2_FIXTURE_DIR points
 * the test at the folder holding it. Without a fixture the test is skipped, and a skip is not a pass.
 * Nothing here passes L2 on synthetic data (cashbookToJournal.test.ts).
 */

import { describe, expect, it } from 'vitest';
import { l2FixturePresent, loadL2Fixture, REAL_FIXTURE_DIR, runL2Harness } from './l2Harness.js';

const present = l2FixturePresent(REAL_FIXTURE_DIR);

describe('L2: migration equivalence, local spreadsheet fixture (L2_FIXTURE_DIR)', () => {
  // it.skip, not an empty it: an empty body counts as a pass in the totals, and a missing fixture
  // must read as not run.
  if (!present) {
    it.skip('not run: no local spreadsheet fixture. It is not committed; set L2_FIXTURE_DIR to the folder holding one', () => {});
    return;
  }

  it('ties every account and month-end to the paisa, and the trial balance, with no unmapped or unbalanced voucher', async () => {
    const result = await runL2Harness(loadL2Fixture(REAL_FIXTURE_DIR));
    expect(result.differences).toEqual([]);
    expect(result.status).toBe('pass');
  }, 900_000);
});
