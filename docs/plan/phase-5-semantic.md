> One phase per session. Read only this file plus `CLAUDE.md`. `README.md` has the audit point and the known line-number drift.

# PHASE 5 — The semantic layer

**Duration:** three weeks. **This phase is what makes Phase 6 safe.** Do not skip it and go straight to the model.

## 5.1 Why not text-to-SQL

On Spider 1.0 — academic, small schemas — GPT-4o scores 86.6%. On Spider 2.0, which uses real enterprise workflows with 1,000–3,000+ column databases, the same model scores **10.1%**, and o1-preview manages 17.1%. A seventy-point cliff. Reported raw text-to-SQL accuracy in production settings is around 40%; a governed semantic layer over the same questions approaches 100% on covered queries.

The failure modes matter more than the headline, because **every one of them produces a plausible wrong number rather than an error**:

- **Fan-out traps** — joining a one-to-many table before aggregating, silently multiplying revenue by the fan factor. In an ERP schema (`invoice → invoice_lines → tax_lines`) this is the number-one wrong-number generator, and your schema has exactly that shape.
- **NULL semantics** — `WHERE status != 'cancelled'` drops every NULL-status row.
- **Date boundaries** — off-by-one on `BETWEEN`, timezone-naive columns, and financial-year versus calendar-year. India's FY runs April–March and the new Act's "Tax Year" renaming makes this worse.
- **Term ambiguity** — "revenue", "active customer" and "headcount" mean different things to Sales, Finance and HR, and the model picks one silently.
- **Prompt injection through data** — a CRM note field containing instructions.

## 5.2 What to build

Create `packages/semantic`. A typed, versioned graph:

```ts
defineEntity('invoice', {
  table: 'invoices',
  tenantScoped: true,
  grain: 'one row per invoice',
  joins: { customer: belongsTo('party'), lines: hasMany('invoice_line') },
  dimensions: { issuedDate: date({ ist: true }), placeOfSupply: string(), status: enum_([...]) },
});

defineMetric('revenue', {
  description: 'Recognised income, net of credit notes, excluding tax.',
  sql: 'SUM(jl.base_amount_minor) FILTER (WHERE a.account_type = \'income\')',
  from: 'journal_line',              // metrics come off the ledger, not off invoices
  grain: 'journal_line',
  synonyms: ['sales', 'turnover', 'top line'],
  requires: { resource: 'finance', verb: 'V' },
});
```

The compiler takes `{ metrics, dimensions, filters, timeGrain, comparison }` and emits SQL with **provable join paths** — it knows the grain of every entity and refuses a combination that would fan out, rather than silently producing it.

**Permissions are applied at compile time, before execution.** Call the existing `visibilityWhere` from `platform/permissions.ts:423` and fold the resulting predicate into the compiled query. A metric the principal has no grant for is not filtered out of the results — it is *not compilable*, and the refusal carries the same five-axis reason the rest of the product uses.

Every query runs as a **read-only, tenant-scoped role** with RLS underneath and a `statement_timeout` as a hard backstop. Not because the compiler is untrustworthy, but because that is what defence in depth means.

## 5.3 The eval harness

`packages/semantic/evals`: at least 200 question/answer pairs per module, with **verified numeric answers**, scored on **exact match of the number**, not similarity. Run in CI on every prompt, schema or model change.

Adversarial cases are mandatory: fan-out joins, NULL-heavy columns, financial-year boundaries (31 March and 1 April, and 00:00–05:30 IST on the first of a month), multi-tenant leakage probes, and prompt-injection payloads planted in CRM note fields and student remarks.
