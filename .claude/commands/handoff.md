---
description: End the session cleanly so the next one starts cheap
allowed-tools: Bash
---
!`git status --short`
!`git log --oneline -5`

Write `docs/plan/HANDOFF.md`, overwriting it, with exactly:

- Phase and item numbers completed this session.
- Phase and item numbers NOT done, and why (blocked / out of context / deferred).
- Any decision taken that is not written in a phase file or a code comment.
- Any plan claim found to be wrong, with `file:line`.
- The single next action.

Keep it under 300 words. The next session reads this instead of re-deriving state,
which is the whole point. Then tell me to `/clear`.
