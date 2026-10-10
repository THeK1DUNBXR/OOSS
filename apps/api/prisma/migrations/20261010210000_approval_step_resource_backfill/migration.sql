-- Backfill approval_steps.resource for share_transaction steps opened before the
-- column existed. The gate only ever overrode the derived resource for
-- share_transaction (platform/approvals.ts GateSubject.resource comment), so for
-- that subjectType the recorded resource is known: share_ledger. The derived
-- `${subjectType}s` would have checked share_transactions, a grant nobody holds.
--
-- Every other null row is deliberately left null. The policy content does not
-- record a resource, so nothing else is derivable; decideApprovalStep refuses
-- those steps with a 409 until an operator sets the resource, rather than
-- checking a guessed grant.
UPDATE "approval_steps"
SET "resource" = 'share_ledger'
WHERE "resource" IS NULL
  AND "subjectType" = 'share_transaction';
