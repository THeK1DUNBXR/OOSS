# Compliance — corporate, contracts and security hygiene

Workstream H of `docs/plan/compliance.md`. What follows is what was built,
the requirement each acceptance ID maps to, and the test that pins it.

## Security hygiene

- **CMP-COR-001** — the API refuses to start with `JWT_SECRET` unset or equal
  to a known fallback value (`dev-secret-change-me`, `change-me-in-production`,
  `docker-development-secret-not-for-production`), outside `NODE_ENV=test` or
  `development` (where it logs one warning and continues). Implemented as
  `assertProductionSecrets(env)` in `apps/api/src/lib/auth.ts`, called
  explicitly in `server.ts` right before `app.listen` — not at module load,
  because this file is also imported by one-off scripts (the fixture seeder,
  `jobs:run`) that have no reason to set `NODE_ENV` and must keep working.
  Pinned by `CMP-COR-001` in `src/tests/compliance/corporate.test.ts`.
- Password policy: `validatePassword()` in
  `packages/shared/src/compliance/corporate.ts` — at least 12 characters, not
  the account's own email, not on a short blocklist. Enforced by
  `changePassword()` (new `POST /auth/change-password`) and available as
  `assertPasswordAllowed()` for any future admin-reset path.
- Account lockout: five failed logins locks the account for 15 minutes;
  reset on the next success. In `login()`, using the `failedLoginCount` /
  `lockedUntil` fields already on `User`. Pinned by `login: lockout`.
- MFA (TOTP, RFC 6238, HMAC-SHA1, 30s, 6 digits) implemented from
  `node:crypto` in `apps/api/src/domains/compliance/corporate/totp.ts` — no
  added dependency. `POST /auth/mfa/enrol` returns a secret and an
  `otpauth://` URI once; `POST /auth/mfa/confirm` sets `mfaEnabledAt` once a
  code checks out. A user with `mfaEnabledAt` set gets `{ mfaRequired: true,
  challengeToken }` from `login()` instead of a session; `POST
  /auth/mfa/verify` completes it. Pinned by the RFC 6238 Appendix B vector
  test and `login: MFA`.
- **CMP-COR-002** — an approve-shaped action this workstream owns (a refund
  approval or payout, marking an MCA filing filed) calls
  `assertStepUpForApprove()`, which refuses the caller's session when their
  role is named in `SecurityPolicy.mfaRequiredForRoleSlugs` (seeded
  `['finance_head', 'chairman']`) and either MFA is not enrolled or this
  session did not come from a completed `/auth/mfa/verify`
  (`stepUpVerified` on the token). **Scope note**: this workstream cannot
  reach every other workstream's own `approve` actions (payroll, tax
  filings) without editing files it does not own — `platform/permissions.ts`
  and `platform/approvals.ts` are off-limits, and there is no generic
  "before approve" hook in `platform/hooks.ts` to attach to instead. The
  mechanism is real and reusable (`assertStepUpForApprove` is exported), and
  applied everywhere in this workstream's own domain; wiring it into another
  workstream's approve path is that workstream's call to make, importing the
  same function. Pinned by `login: MFA` (the challenge itself) and
  `CMP-COR-002` (the gate at the point of use).
- Rate limiting: a small in-memory token-bucket (`rateLimit.ts`), five
  attempts per minute per IP and per email on `POST /auth/login`. **A
  multi-process deployment needs a shared store (Redis, or a table behind an
  atomic increment) for this to hold across instances** — this is
  process-local state, stated rather than pretended away.
- Backups: `runBackup()` shells `pg_dump` via `child_process` to
  `BACKUP_DIR/kaizen-<date>.sql.gz` when `BACKUP_DIR` is set (a quiet no-op
  otherwise), gzipped, sha256'd, recorded as a `BackupRun` row, raising
  `CMP_BACKUP_FAILED` on error. Scheduled daily (`runComplianceBackupJob`);
  `GET /compliance/corporate/security/backups` and a manual `POST
  .../security/backups/run`.

## Company registrations

`isValidTan`, `isValidCin`, `isValidUdyam`, `checkPanAgainstGstin` in
`packages/shared/src/compliance/corporate.ts` — pure, format-only checks
(the portal is the authority on whether a number is actually allotted, the
same posture `isValidGstin` already takes). `companyProfile.ts` calls all
four on `updateCompanyProfile`, refusing a GSTIN whose embedded PAN
(characters 3-12) disagrees with the profile's own PAN. Pinned by `company
registrations` in the test file.

## Statutory registers

`RegisterEntry` (`registerKind`: members/directors/charges/kmp/related_party,
a kind-shaped `body` Json), append-only: a change is a new row with
`supersedesId` pointing at the entry it supersedes, refused unless that is
the current head of the subject's chain. `currentRegister()` resolves the
unsuperseded head per subject; `exportRegisterCsv()` exports it. Routes
under `/compliance/corporate/registers`, gated on the `corporate_registers`
grant. **CMP-COR-003 note**: distinct entity from `BoardResolution` below,
matching the plan's instruction not to conflate the two append-only shapes.

## Board minutes

`BoardMeeting` (kind board/agm/egm, status draft→recorded, one-way) and
`BoardResolution` (numbered per meeting, kind ordinary/special/circular),
distinct from `Decision` (business governance, not a statutory record).
**CMP-COR-003**: `addBoardResolution` refuses a bare addition once the
meeting is `recorded` — a correction must name `correctsId`, and the
original resolution's text is never touched. Pinned by `CMP-COR-003` in the
test file.

## MCA filings

`MCA_FILINGS` in shared (`AOC-4`, `MGT-7`/`MGT-7A`, `DIR-3 KYC`, `ADT-1`,
`DPT-3`, `MSME-1`) with plain-text due rules, for workstream A's calendar to
seed as `ComplianceObligation` rows — exported, not yet consumed (that is
workstream A's seed to write). `McaFiling` (form, fy, srn, filedOn, status)
with routes; marking one `filed` is a CMP-COR-002-gated act.

## Contracts

- **Stamp duty**: `StampDutyRule` (dated, by agreement kind — TN, seeded
  with placeholder figures and a note to confirm against the current Stamp
  Act schedule). `agreements.ts`'s `transitionAgreement` calls
  `assertStampDutySatisfied` on a `signed` transition for MoU, Contract and
  Partner Agreement alike, refusing the transition unless a `Document`
  attached to the agreement carries a `stampDutyRef`.
- **E-signature**: `ESignProvider` interface (`request`, `status`);
  `NotConfiguredProvider` is what every tenant has until an `ESignConfig` row
  names a real one — `POST /compliance/corporate/documents/:id/esign`
  returns `ESIGN_NOT_CONFIGURED` until then.
- **Retention**: `DocumentRetentionRule` by `documentKind` (seeded: contracts
  8 years after expiry, invoices 8 financial years, HR files 3 years after
  exit). `POST /compliance/corporate/documents/:id/retention` sets
  `Document.retainUntil` from the rule and a caller-supplied anchor date.

## FEMA

`PATCH /compliance/corporate/payments/:id/foreign` updates
`Payment.foreignCurrency/foreignAmount/fircNumber/fircDate` (audited). A
monthly job (`runFemaFircSweepJob`) raises `CMP_FEMA_FIRC_MISSING` for a
foreign receipt more than 30 days old with no `fircNumber`.

## Refunds and certificates

- **CMP-COR-004**: `Refund` (invoiceId/receiptId, amount, reason, status
  requested→approved→paid) never edits the original invoice or receipt.
  Approving refuses a requester approving their own refund
  (`approvedById !== requestedById`, checked directly — never a role
  comparison). Paying calls `books.recordTransaction` with `source:
  'refund'`, direction `out` — a second, separate Movement fact. `recordCode`
  comes from document series `N`. `RefundPolicy` is versioned text plus rules
  (`fullWithinDays`/`partialPercent`/`noneAfterStartDays`), seeded with a
  first version — the company has not yet confirmed its own written policy
  (an open question in the plan), so this is a stated starting point, not
  the company's answer. Pinned by `CMP-COR-004`.
- `Certificate` (kind completion/participation, number from series `T`,
  `verificationCode` unique, final once issued — a correction is a new
  certificate). `GET
  .../certificates/verify/:code` is public-*shaped* (a code, not an id) but
  still sits behind this router's `requireAuth` — stated on the route and on
  screen, not a silent gap. Pinned by `certificate verification`.

## What was not built

- **A generic "before approve" hook.** CMP-COR-002's mechanism
  (`assertStepUpForApprove`) is applied to every approve-shaped action this
  workstream owns, and is exported for any other workstream to call from its
  own approve path — but this workstream cannot reach payroll approval or a
  tax filing's approval without editing files outside its ownership.
- **A field on `main.prisma`**: none needed beyond what was already added
  (`User.mfaSecret/mfaEnabledAt/passwordChangedAt/failedLoginCount/lockedUntil`,
  `Payment.foreignCurrency/foreignAmount/fircNumber/fircDate`,
  `CompanyProfile.tan/udyamNumber`).
- Real Aadhaar eSign / DSC integration — `NotConfiguredProvider` is the
  honest state until a tenant picks a provider, matching the plan's own
  "will not be a certifying authority" boundary.

## Open questions (from the plan, restated)

Current directors and registered charges for statutory-register seed data;
any foreign receipts today; a written refund policy — none of these were
answerable from inside the codebase, so the registers ship empty and the
refund policy ships as a stated placeholder rather than a guess.
