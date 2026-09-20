---
description: Pre-flight a finance-path change before opening the PR
allowed-tools: Bash
---
This change touches money. Before the PR:

1. !`git diff --stat`
2. Confirm every new amount is `bigint` minor units and goes through `packages/shared/src/money.ts`. No floats, no `Math.round`, no epsilon comparisons.
3. Confirm every journal write goes through `platform/ledger.ts` `post()`.
4. Confirm the trial-balance assertion exists and runs: !`pnpm --filter @kaizen/api test -- trialBalance --reporter=dot 2>&1 | tail -15`
5. State the assertion's result in the PR body.

If any of 2-4 fails, fix it before opening the PR. A finance PR without a trial-balance assertion has not been reviewed.
