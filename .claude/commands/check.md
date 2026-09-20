---
description: Typecheck and test, with output truncated to what matters
allowed-tools: Bash
---
Run, in order, stopping at the first failure:

!`pnpm typecheck 2>&1 | grep -E "error TS|Found [0-9]+ error" | head -30`

!`pnpm --filter @kaizen/api test -- --reporter=dot 2>&1 | tail -40`

Report pass or fail and the specific failures. Do not paste output that passed.
