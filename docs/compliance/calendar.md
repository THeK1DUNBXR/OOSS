# Compliance calendar and register

The spine every statutory deadline sits on (`docs/plan/compliance.md`,
workstream A). No single deadline lived anywhere before this: GST returns,
TDS, PF, ESI, Tamil Nadu Professional Tax, advance tax and the MCA filings
were each a date somebody had to remember. This turns each into a row,
materialised ahead of time, chased by a daily job, and closed only by filing
it with the portal's own acknowledgement or by a deliberate waiver.

---

## Model

**`ComplianceObligationType`** — the standing rule: what it is, which law and
section, which domain (`fin` | `hr` | `gov` | `edu`), how often it recurs,
its due-date arithmetic (`dueRule`, a `Json` field, never a constant in
code), which role owns it, and whether filing it requires evidence.

**`ComplianceObligation`** — one period's instance: a due date, a status
(`upcoming` → `due` → `filed` | `overdue` | `waived`), and — once filed — the
portal's reference, who filed it, and when. `(tenantId, typeId, period)` is
unique, so a period is materialised once.

Due-date arithmetic is pure and lives in
`packages/shared/src/compliance/calendar.ts` as `nextDueDates(rule,
recurrence, fromDate, months)`. It reads five `dueRule` shapes — monthly
(`{day}`, with per-source-month `overrides`), quarterly (`{quarterDates}`,
one date per calendar quarter), half-yearly (`{halfYearDates}`), annual
(`{month, day}` or `{monthsAfterFyEnd, day}`), and one-off (`{date}`) — and
needs no database, so it is exercised directly by unit tests.

## Seed

`apps/api/src/seed/compliance/calendar.ts` seeds sixteen obligation types by
idempotent upsert on `code`:

| Code | Recurrence | Due |
|---|---|---|
| GSTR1 | monthly | 11th of next month |
| GSTR3B | monthly | 20th of next month |
| TDS_DEPOSIT | monthly | 7th of next month; 30 April for March |
| TDS_24Q / TDS_26Q | quarterly | 31 May / 31 Jul / 31 Oct / 31 Jan |
| PF_ECR | monthly | 15th |
| ESI_CONTRIB | monthly | 15th |
| PT_TN | half-yearly | 30 Sep / 31 Mar — confirm against the company's own PT enrolment |
| ADVANCE_TAX | quarterly | 15 Jun / Sep / Dec / Mar |
| AOC4 | annual | 30 Oct (default; actually 30 days after the AGM) |
| MGT7 | annual | 29 Nov (default; actually 60 days after the AGM) |
| DIR3_KYC | annual | 30 Sep |
| POSH_ANNUAL | annual | 31 Jan, for the calendar year |
| ITR_COMPANY | annual | 31 Oct |
| FORM16 | annual | 15 Jun |
| GSTR9 | annual | 31 Dec |

## Domain (`apps/api/src/domains/compliance/calendar.ts`)

- `generateObligations(horizonMonths = 3)` — materialises every active
  type's due periods for the horizon. Idempotent: a period already
  materialised (the unique constraint) is left exactly as it stands, so a
  re-run never resets a filed or waived row back to `upcoming`.
- `listTypes` / `listObligations(filter)` / `obligationDetail(id)` /
  `summary()` — reads, gated on `compliance_obligations:view`.
- `markFiled(id, { reference, evidenceDocumentId?, note? })` — gated on
  `compliance_obligations:approve`. Refuses without a `reference` (the
  portal's ARN, challan or acknowledgement number), and refuses without
  `evidenceDocumentId` when the type says evidence is required
  (**CMP-CAL-002**).
- `waive(id, reason)` — gated on `approve`; refuses without a reason.
- An obligation's owner is never a role comparison in this file's logic: it
  is the `partyId` of the active `Affiliation` carrying the type's
  `ownerRoleSlug`, looked up as data. An obligation nobody currently holds
  that role for raises `CMP_CAL_UNOWNED` against `H_OPS` rather than being
  silently skipped (**CMP-CAL-003**).

`finance_head` holds `approve` on `compliance_obligations`; `hr_ops_manager`
holds only `view`. Only Finance files or waives.

## Job (`apps/api/src/jobs/compliance/calendar.ts`)

Daily at 06:00: generates the next three months, flips
`upcoming`/`due`/`overdue` as deadlines approach and pass, and fires a
30/7/1-days-before and 1-day-after ladder — the tightest crossed rung,
recorded on `notifiedRungs`, so a rerun never re-fires a rung already spent.
Each firing raises `CMP_CAL_DUE` (before) or `CMP_CAL_OVERDUE` (after) on
the resolved owner, with `slaDueAt` set to the due date.

## Routes (mounted at `/api/compliance/calendar`)

`GET /types`, `GET /` (filters: `status`, `domain`, `period`, `typeId`),
`GET /summary`, `GET /:id`, `POST /generate`, `POST /:id/file`, `POST
/:id/waive`.

## Web (`apps/web/src/pages/compliance/Calendar.tsx`)

Summary tiles (due soon / overdue / upcoming / filed this FY), a table by
due date with a File modal (reference + evidence where required + note) and
a Waive action, domain filter tabs, and a footnote: "Prepares and tracks;
filing happens on the portal — record the acknowledgement here."

## Tests (`apps/api/src/tests/compliance/calendar.test.ts`)

- `CMP-CAL-ARITH-001..007` — `nextDueDates` against every rule shape, no
  database.
- `CMP-CAL-001` — every seeded type materialises; GSTR-3B for 2026-08 is due
  2026-09-20.
- `CMP-CAL-002` — filing without a reference is refused; filing an
  evidence-required type without a document is refused; filing with both
  succeeds.
- `CMP-CAL-003` — an obligation type with nobody holding its owner role
  raises `CMP_CAL_UNOWNED` with `ownerUnresolved: true`.
- Generation is idempotent; the daily job's ladder is idempotent across two
  runs (one exception, not two).
- The Operations Head cannot file (the `hr_ops_manager` grant lacks
  `approve`); waiving needs a reason and blocks a later filing.

## Open questions (from the plan)

Which registrations the company currently holds — GST, TAN, PF code, ESI
code, PT (which state/jurisdiction), CIN — and the company's actual AGM date
each year, which the AOC-4/MGT-7 default due dates assume rather than know.
