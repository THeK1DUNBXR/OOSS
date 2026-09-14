# HCM — workforce (WS1)

Employee master extensions, org design and org chart, directory, the
employee-360 aggregate, and employee status changes (transfer, promotion,
demotion, redesignation) proposed then decided under the Self-Dealing Bar
then applied.

## What exists now

### Models (`apps/api/prisma/schema/hcm-workforce.prisma`)

- `EmployeeProfileExtension` — one row per employment: gender, marital
  status, nationality, passport number/expiry (regulated — masked to the
  last four characters for anyone not viewing their own record at
  `employee_profiles:view@all`), emergency contacts, current/permanent
  address, education history, previous employment, dependants (all JSON
  arrays/objects).
- `EmployeeDocument` — id proof / address proof / education / offer /
  contract / other, base64 content, `verified` flag set only by a distinct
  `edit`-grant holder (never the uploader themselves, structurally, since
  the `employee` role holds no `edit` on this resource).
- `ReportingLine` — dated, `primary` (exactly one open at a time) or
  `dotted`; the org chart is built from the open primary lines.
- `CostCentre`, `CostCentreAssignment`, `Location`, `LocationAssignment`,
  `Grade` (code/name/level only — **no pay range**; WS7's `PayGrade` owns
  pay), `GradeAssignment`.
- `EmployeeStatusChange` — `transfer | promotion | demotion |
  redesignation`, `pending_approval → approved|rejected → applied`. Proposed
  by anyone holding `employee_changes:create`; decided by anyone holding
  `employee_changes:approve` **other than the proposer** (unconditional,
  same shape as `approvals.ts`'s Self-Dealing Bar); applying writes the new
  `GradeAssignment`/`CostCentreAssignment`/`LocationAssignment` row(s) named
  in `changes`.

### Shared pure logic (`packages/shared/src/hcm/workforce.ts`)

Closed vocabularies (document kinds, reporting-line kinds, status-change
kinds/states + transition table), `maskRegulatedId`, the org-tree builder
(`buildOrgTree`/`OrgChartPersonFact`, roots anyone whose manager fact does
not resolve), `spanOfControl`, and `statusChangeDiff` for the apply-time
audit record.

### Endpoints (`/api/hcm/workforce`)

- `GET /org-chart` — the tenant's current primary-line tree.
- `GET /directory?q=&orgUnitId=&status=` — name/unit/status search.
- `GET /employees/:id/360` — the aggregate: employment + person (regulated
  fields on `Person`/`EmploymentRelationship` excluded exactly as
  `redactRegulatedEmploymentFields` excludes them elsewhere), profile
  extension (masked where applicable), documents, reporting lines both
  directions, current grade/cost-centre/location, status-change history.
- `GET/PATCH /employees/:id/profile`
- `GET/POST /employees/:id/documents`, `GET /documents/:id/content`,
  `POST /documents/:id/verify`
- `GET /employees/:id/reporting-lines`, `POST /reporting-lines`
- `GET/POST /cost-centres`, `/locations`, `/grades`
- `GET/POST /status-changes`, `POST /status-changes/:id/decide`,
  `POST /status-changes/:id/apply`

### Web

- `OrgChart.tsx` (`/people/org-chart`) — the reporting tree, linking each
  name to Employee 360.
- `Directory.tsx` (`/people/directory`) — searchable staff list.
- `Employee360.tsx` (`/people/employees/:id/360`) — Profile / Documents /
  Reporting / History tabs; a decide button is hidden (not disabled) for
  whoever proposed the change, with the reason stated plainly, rather than
  offered and then refused.
- One `Link` added to `PeopleOps.tsx`'s `EmployeeDetail` ("Full profile" →
  the 360 page).

## Acceptance

| ID | PASS means | Test |
| --- | --- | --- |
| HCM-WORKFORCE-001 | HR can write and read the full profile extension | `HCM-WORKFORCE-001` |
| HCM-WORKFORCE-002 | Passport number reads back in full on one's own record | `HCM-WORKFORCE-002` |
| HCM-WORKFORCE-003 | An employee can upload their own document but cannot verify it (403) | `HCM-WORKFORCE-003` |
| HCM-WORKFORCE-004 | HR verifies once; a second verify on the same document is refused (400) | `HCM-WORKFORCE-004` |
| HCM-WORKFORCE-005 | A new primary reporting line closes the old one; the org chart nests correctly | `HCM-WORKFORCE-005` |
| HCM-WORKFORCE-006 | An employment cannot report to itself (400) | `HCM-WORKFORCE-006` |
| HCM-WORKFORCE-007 | Directory search finds an employee by name | `HCM-WORKFORCE-007` |
| HCM-WORKFORCE-008 | Employee 360 aggregates profile, documents and reporting lines | `HCM-WORKFORCE-008` |
| HCM-WORKFORCE-009 | A non-existent employment id 404s on the 360 aggregate | `HCM-WORKFORCE-009` |
| HCM-WORKFORCE-010 | Cost centre, location and grade can be created and listed | `HCM-WORKFORCE-010` |
| HCM-WORKFORCE-011 | The proposer of a status change may never decide it (403, Self-Dealing Bar) | `HCM-WORKFORCE-011` |
| HCM-WORKFORCE-012 | A different decider can approve; applying writes the grade assignment; re-deciding/re-applying are refused (409) | `HCM-WORKFORCE-012` |

## What this does not do

- No pay ranges on `Grade` — that is WS7's `PayGrade`, deliberately kept
  separate per the plan's coordination note.
- No record code is minted for `EmployeeStatusChange`,
  `EmployeeProfileExtension` or `EmployeeDocument` — none of the three has a
  reserved prefix in `RECORD_TYPE_CODES`, and editing that shared enum
  concurrently with twelve other workstreams was judged a bigger risk than
  going without a human-spoken code for these three. Everything else on
  these rows (ids, audit trail, events) is fully traceable without one.
- Employee-to-CRM-person cross-linking beyond what already exists: a person
  and an employment already share one `Person` row (`employment360`'s
  `person.recordCode` links straight to `/crm/people/:id`); adding a link
  the other way, from `People.tsx`'s `PersonDetail` affiliation rows back to
  `/people/employees/:id`, was skipped because the `Affiliation` row CRM
  reads there does not carry an `employmentRelationshipId` — see "Wanted
  from the scaffold".
- No document storage backend — `EmployeeDocument.content` is base64 text in
  Postgres, sized for HR paperwork, not a general file store.
- No applying of a `redesignation`'s "designation" text onto the
  `Position`/`Job` a person actually sits in — `Assignment`/`Position` are
  `employment.ts`'s domain; `EmployeeStatusChange.changes.designation` is
  recorded as a fact on the change itself (and in its audit diff) but does
  not rewrite the seat's job title, which stays employment.ts's job to do.

## Wanted from the scaffold

- `RECORD_TYPE_CODES` (`packages/shared/src/domain.ts`) has no prefix
  reserved for an employee status change, a profile extension or a
  document — unlike WS4/WS5/WS7/etc.'s TSH/OFR/RVW/… A future scaffold pass
  could add one (e.g. `ESC` for status changes) without any workstream
  having to touch the shared enum mid-build.
- `Affiliation` (main.prisma) carries `positionId` but no
  `employmentRelationshipId`, so a CRM `PersonDetail` affiliation row for an
  `employeeType: 'employee'` affiliation cannot link straight to
  `/people/employees/:id` without an extra lookup. Exposing that id on the
  affiliation (or on the `/crm/people/:id` response) would close the gap the
  plan calls out under "cross-link CRM person ↔ employee".
