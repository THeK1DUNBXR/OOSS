# The budget block

Paste at the top of any Claude Code prompt, any repo, any task. It turns off five
default behaviours that each cost tokens and none of which you asked for.

Reasoning for each line is at the end of `docs/plan/prompts.md`.

```
Work to a token budget. Before you begin:

- Read ONLY the files I name. Do not read siblings, do not "get oriented", do not
  survey the repo. docs/plan/MAP.md has every model, symbol, route and page with
  file:line — look things up there, not by searching.
- Read with offset/limit against MAP's line numbers. Never open a file over 400
  lines whole. Use Edit, not Write, unless the file is new.
- Do not narrate. No "let me...", no "now I'll...", no restating the task back to
  me, no summary of what you just did beyond one or two sentences at the very end.
- Batch independent tool calls into one message. Do not run them one at a time and
  comment between each.
- Any search touching more than three files goes to a subagent, and the subagent
  returns conclusions with file:line — not file contents.
- Pipe noisy commands: `2>&1 | grep -E "error" | head -30`, `| tail -20`. Never let
  a full test or build log into context.
- Do not re-read a file you just edited. Edit would have errored if it failed.
- Do not re-verify facts I have given you. Confirm a single line with grep -n if it
  is load-bearing; do not re-audit.

While you work:

- Stop when the named scope is done. Do not improve adjacent code, do not add tests
  I did not ask for, do not refactor on the way past.
- If you hit something the task did not anticipate, stop and ask in one sentence.
  Do not explore your way to an answer.
- At roughly 70% context, stop, run /handoff, and tell me what is left. Do not push
  on to a half-finished refactor — recovering one costs more than redoing it.
```
