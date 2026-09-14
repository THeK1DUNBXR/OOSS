/**
 * Compliance — corporate, contracts and security hygiene
 * (docs/plan/compliance.md, H).
 *
 * This file registers the governed entities this workstream owns and
 * re-exports the actual work, split by area under `./corporate/*` because
 * "corporate, contracts and security hygiene" is eight distinct things —
 * security policy, statutory registers, board minutes, MCA filings,
 * contracts (stamp duty, e-signature, retention), FEMA, refunds and
 * certificates — and a single file covering all eight would be the kind of
 * file nobody reads end to end before changing it.
 */

import { registerGovernedEntities } from '../../platform/audit.js';

registerGovernedEntities('cmp_corporate', [
  'security_policy',
  'register_entry',
  'board_meeting',
  'board_resolution',
  'mca_filing',
  'refund',
  'refund_policy',
  'certificate',
]);

export * from './corporate/totp.js';
export * from './corporate/rateLimit.js';
export * from './corporate/security.js';
export * from './corporate/registers.js';
export * from './corporate/board.js';
export * from './corporate/mca.js';
export * from './corporate/contracts.js';
export * from './corporate/fema.js';
export * from './corporate/refunds.js';
export * from './corporate/certificates.js';
