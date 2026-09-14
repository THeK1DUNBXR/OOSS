# G. Data protection and privacy (DPDP)

What this workstream built against `docs/plan/compliance.md` §G, and the test
that pins each requirement. Tests live in
`apps/api/src/tests/compliance/privacy.test.ts`.

## What exists now

- **Privacy notice.** `PrivacyNotice` (version, effectiveFrom, body, purposes
  Json list of `{code, label, lawfulBasis, dataCategories, retention}`).
  `POST /compliance/privacy/notice` publishes a new version, which supersedes
  the one before it rather than editing it — the chairman only, since that is
  the one role holding `create` on `privacy_notices`. Seeded with the five
  purposes the platform actually processes data for: employment,
  education_delivery, invoicing, statutory_filing, marketing.
  `GET /compliance/privacy/notice/current`, `POST /notice/acknowledge`
  records a `NoticeAcknowledgement` per person per version.

- **Consent — the WHY axis's real data.** `Consent` (personId, purposeCode,
  status granted/withdrawn/expired, grantedAt, withdrawnAt, channel, evidence,
  guardianOfPersonId, expiresAt). `contextMiddleware`
  (`apps/api/src/lib/http.ts`) calls `grantedConsentCodes` on every
  authenticated request and sets `ctx.auth.consentCodes` from it; it reads
  `X-Purpose` and sets `ctx.auth.purpose` only when the header names a purpose
  the current notice covers (`resolvePurpose`), otherwise `'operational'`.
  Before this, `permissions.ts`'s WHY axis always evaluated `requiredConsent`
  against an empty array — CMP-DPD-001 pins that it now denies without a
  matching `Consent` row and allows with one.

- **Minor / guardian consent gate.** `students.ts`'s `attachStudentProfile`
  (which both `createStudent` and the direct-attach path go through) calls
  `requireGuardianConsentForMinor` before creating the `StudentProfile`. If
  `Person.dateOfBirth` puts them under 18, it refuses without a guardian name
  and phone, and records a `Consent` row (`purposeCode: 'education_delivery'`,
  `guardianOfPersonId` set) that its id is stamped onto
  `StudentProfile.guardianConsentId`. `flagMajorityTransitions` (monthly job)
  raises `CMP_DPD_MAJORITY` for a guardian-consented student whose age has
  since crossed 18 — the consent basis changed, not a violation. CMP-DPD-003.

- **Data-principal requests.** `DataPrincipalRequest` (personId, kind
  access/correction/erasure/nomination, status
  received/verifying/fulfilled/refused, receivedAt, dueAt = +30 days via
  `DATA_REQUEST_DUE_DAYS`, fulfilledAt, refusalReason, response Json).
  `POST /requests` — an employee raises their own (record scope `@own`), HR
  raises on behalf (`@all`). `POST /requests/:id/fulfil`: access assembles a
  JSON export across Person/Affiliation/EmploymentRelationship/StudentProfile
  via `unscopedPrisma` under the tenant (the person's own data, decrypted
  through `readRegulated`), then `auditExport`; correction applies the given
  patch to `Person` with `auditWrite`; erasure checks
  `Affiliation.statutoryRetentionFloor` against `RetentionSchedule` — inside
  the floor it sets `status: 'refused'` with the floor and earliest erasable
  date named (CMP-DPD-002), outside it soft-deletes and scrubs PII to
  `erased:<personId>`. A daily job raises `CMP_DPD_REQUEST_OVERDUE` past
  `dueAt`.

- **Breach register.** `DataBreach` (detectedAt, description, categories,
  principalsAffected, severity, status
  open/contained/notified_board/notified_principals/closed, boardNotifiedAt,
  principalsNotifiedAt, notes). `POST /breaches`, `POST /breaches/:id/transition`
  (a fixed transition table — no skipping straight to `notified_principals`).
  An hourly job (`runBreachLadder`) raises `CMP_DPD_BREACH_72H` at S4 once per
  rung at 24/48/72 hours since `detectedAt`, idempotent via
  `raiseException`'s `triggerFingerprint`/`ladderRung`, until
  `boardNotifiedAt` is set.

- **Retention.** `RetentionSchedule` (retentionClass → years, dated by
  `effectiveFrom` — never a constant). Seeded: `standard` (3y),
  `employee_record` (8y), `student_record` (5y). A monthly job
  (`runRetentionReport`) reads `EventRecord.retentionClass`, counts what is
  past each class's window, and snapshots a `RetentionReport` — it reports,
  it never deletes. `GET /compliance/privacy/retention`.

- **Access revocation.** A hook registered on `offboarding.completed`
  (`apps/api/src/platform/hooks.ts`, called from
  `employment.ts`'s `transitionOffboarding`) ends every active `Affiliation`
  of the offboarded person, stamping `revokedAt`/`revokedReason: 'offboarding'`
  and auditing it. A weekly job (`runAccessReview`) snapshots every active
  employee affiliation whose employment status is not `Active` into an
  `AccessReview` row and raises `CMP_DPD_STALE_ACCESS` for each.

- **Field-level encryption at rest.** `encryptField`/`decryptField`
  (AES-256-GCM, keyed from `FIELD_ENCRYPTION_KEY`, with a named development
  fallback and a startup warning when it is unset) and `readRegulated`, the
  read-side helper any write path should call. `POST
  /compliance/privacy/encrypt-at-rest/backfill` (chairman only, via
  `security_settings:edit`) encrypts existing plaintext PAN, Aadhaar and bank
  values on `EmploymentRelationship` in place, prefixing `enc:v1:`; the
  fulfilled-access export decrypts through `readRegulated` so a data
  principal still sees their own value. CMP-DPD-004.

## Where plaintext can still land

PAN, Aadhaar, UAN, ESIC number and bank details are written by
`apps/api/src/domains/employment.ts` (`hire`, `updateEmployeeProfile`, and
wherever payroll instructions carry them) — a workstream E/F file this one
does not own. That write path does not call `encryptField`; it writes
plaintext, structurally excluded from API responses
(`redactRegulatedEmploymentFields`) but not encrypted at rest until the
backfill endpoint above is run. The backfill closes the gap for what is
already on disk; it does not intercept new writes. Whoever owns
`employment.ts` should call `encryptField` at the point of write and read
through `readRegulated`, the same way this module's own write paths do.

## Requirement IDs and their tests

| ID | What it pins | Test |
|---|---|---|
| CMP-DPD-001 | A regulated read via a purpose requiring consent fails without a matching `Consent` row, and passes with one — through `evaluate()` with `requiredConsent` set. | `CMP-DPD-001: a regulated read via a purpose that requires consent` |
| CMP-DPD-002 | An erasure request inside the statutory retention floor is refused, naming the floor and the earliest erasable date. | `CMP-DPD-002: erasure inside the statutory retention floor` |
| CMP-DPD-003 | A minor `StudentProfile` cannot be created without a linked guardian-consent record. | `CMP-DPD-003: a minor StudentProfile needs a guardian consent` |
| CMP-DPD-004 | PAN/Aadhaar/bank values are encrypted at rest, verified by reading the raw column directly. | `CMP-DPD-004: PAN/Aadhaar/bank values encrypted at rest` |
| — | The 72-hour breach ladder fires once per rung, not once per job run. | `Breach register: the 72-hour ladder > fires once per rung and does not duplicate on a second run` |
| — | A data-principal request's `dueAt` is 30 days after receipt. | `Data-principal requests > dueAt is set 30 days...` |
| — | Every active affiliation ends when offboarding reaches `ClosedArchived`, driven through `employment.ts`'s real state machine. | `Access revocation follows offboarding to its close` |
| — | A stale affiliation (active, employment not Active) raises `CMP_DPD_STALE_ACCESS`. | `Access review: stale access flagged, CMP_DPD_STALE_ACCESS` |

## What this workstream did not do, and why

- No cross-border data transfer control (DPDP allows notified transfers; the
  open question in the plan — whether the company receives personal data from
  outside India — was left to the company to answer, so nothing here
  represents that it enforces one).
- No DPO/grievance-contact model beyond `CompanyProfile.grievanceOfficerName`
  and `grievanceOfficerEmail`, which already existed on `main.prisma`.
- `encrypt-at-rest/backfill` only reaches `EmploymentRelationship`'s PAN,
  Aadhaar and bank fields — the fields this workstream was told about. Any
  other regulated identifier written elsewhere is not covered until it is
  named.
