/**
 * Technology — security and governance (docs/plan/cio.md, workstream F).
 *
 * Split into `domains/it/governance/{risks,policies,controls,accessReviews,
 * findings}.ts`, re-exported from here so routes/tests/jobs import a single
 * module the same way every other workstream's domain file works.
 */

export * from './governance/risks.js';
export * from './governance/policies.js';
export * from './governance/controls.js';
export * from './governance/accessReviews.js';
export * from './governance/findings.js';
