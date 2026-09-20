/**
 * Chairman's Office — detector registration (docs/plan/ceo-office.md §6, Phase 0).
 *
 * Imports one detector-list export from each area's own `<area>.detectors.ts`
 * and runs them all. Phase 0's only edit to `jobs/scheduler.ts` is a single
 * `runCeoDetectors()` job registration that calls this — every phase's own
 * detectors run without any phase touching the scheduler itself, and this
 * file never needs to change when an area's stub is replaced with real
 * detectors, since it only ever imports the exported `detectors` array.
 */

import { detectors as cockpitDetectors } from './cockpit.detectors.js';
import { detectors as strategyDetectors } from './strategy.detectors.js';
import { detectors as initiativesDetectors } from './initiatives.detectors.js';
import { detectors as rhythmDetectors } from './rhythm.detectors.js';
import { detectors as doaDetectors } from './doa.detectors.js';
import { detectors as boardDetectors } from './board.detectors.js';
import { detectors as riskDetectors } from './risk.detectors.js';
import { detectors as financeDetectors } from './finance.detectors.js';
import { detectors as peopleDetectors } from './people.detectors.js';

const ALL_CEO_DETECTORS: Array<() => Promise<void>> = [
  ...cockpitDetectors,
  ...strategyDetectors,
  ...initiativesDetectors,
  ...rhythmDetectors,
  ...doaDetectors,
  ...boardDetectors,
  ...riskDetectors,
  ...financeDetectors,
  ...peopleDetectors,
];

/** Runs every registered Chairman's Office detector for the current tenant. */
export async function runCeoDetectors(): Promise<number> {
  for (const detect of ALL_CEO_DETECTORS) {
    await detect();
  }
  return ALL_CEO_DETECTORS.length;
}
