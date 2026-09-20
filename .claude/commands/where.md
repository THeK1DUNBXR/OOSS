---
description: Look up where a model, function, route or page lives — without grepping
---
Find `$ARGUMENTS` in `docs/plan/MAP.md` and report the `file:line`.

Read only MAP.md. If it is not there, MAP.md is stale — run `node scripts/genmap.mjs`
and look again. Only if it is still missing, search the source, and say that you had to.

Then read the relevant lines with `Read` using `offset` and `limit`. Never the whole file.
