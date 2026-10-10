-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "LedgerAccountType" AS ENUM ('asset', 'liability', 'equity', 'income', 'expense');

-- CreateTable
CREATE TABLE "cmp_accounting_periods" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entityId" TEXT,
    "startsOn" DATE,
    "endsOn" DATE,
    "fy" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "requestedById" TEXT,
    "requestedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "closedAt" TIMESTAMP(3),
    "reopenedById" TEXT,
    "reopenedAt" TIMESTAMP(3),
    "reopenReason" TEXT,
    "snapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cmp_accounting_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entities" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "gstin" TEXT,
    "pan" TEXT,
    "tan" TEXT,
    "stateCode" TEXT NOT NULL,
    "baseCurrency" TEXT NOT NULL DEFAULT 'INR',

    CONSTRAINT "ledger_entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "entryNumber" TEXT NOT NULL,
    "entryDate" DATE NOT NULL,
    "postedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'posted',
    "narration" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT,
    "reversalOfId" TEXT,
    "reversedById" TEXT,
    "idempotencyKey" TEXT,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_lines" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "accountId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "baseAmountMinor" BIGINT NOT NULL,
    "fxRate" DECIMAL(18,8),
    "division" TEXT,
    "costCentreId" TEXT,
    "projectId" TEXT,
    "partyId" TEXT,
    "taxCodeId" TEXT,
    "memo" TEXT,

    CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cmp_retention_policies" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "years" INTEGER NOT NULL,
    "basis" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cmp_retention_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cmp_retention_reviews" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "recordDate" TIMESTAMP(3) NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'flagged',
    "note" TEXT,
    "flaggedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,

    CONSTRAINT "cmp_retention_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cmp_schedule_iii_mappings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "categoryId" TEXT,
    "accountId" TEXT,
    "statement" TEXT NOT NULL,
    "scheduleHead" TEXT NOT NULL,
    "scheduleSubHead" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cmp_schedule_iii_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cmp_schedule_ii_useful_life" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assetClass" TEXT NOT NULL,
    "usefulLifeYears" INTEGER NOT NULL,
    "residualPercent" DECIMAL(5,2) NOT NULL DEFAULT 5,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cmp_schedule_ii_useful_life_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cmp_it_depreciation_blocks" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "blockName" TEXT NOT NULL,
    "ratePercent" DECIMAL(5,2) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cmp_it_depreciation_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cmp_bank_statement_lines" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "direction" TEXT NOT NULL,
    "reference" TEXT,
    "narration" TEXT,
    "matchedTransactionId" TEXT,
    "matchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cmp_bank_statement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_obligation_types" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "governingLaw" TEXT NOT NULL,
    "section" TEXT,
    "domain" TEXT NOT NULL,
    "recurrence" TEXT NOT NULL,
    "dueRule" JSONB NOT NULL,
    "ownerRoleSlug" TEXT NOT NULL,
    "evidenceRequired" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compliance_obligation_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_obligations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "typeId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'upcoming',
    "filedAt" TIMESTAMP(3),
    "filedById" TEXT,
    "evidenceDocumentId" TEXT,
    "reference" TEXT,
    "note" TEXT,
    "notifiedRungs" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "recordCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compliance_obligations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_policies" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "mfaRequiredForRoleSlugs" TEXT[] DEFAULT ARRAY['finance_head', 'chairman']::TEXT[],
    "sessionHours" INTEGER NOT NULL DEFAULT 12,
    "passwordMinLength" INTEGER NOT NULL DEFAULT 12,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "security_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_backup_runs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "path" TEXT,
    "sizeBytes" INTEGER,
    "sha256" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "compliance_backup_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_register_entries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "registerKind" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "body" JSONB NOT NULL,
    "supersedesId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_register_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_board_meetings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "heldOn" TIMESTAMP(3) NOT NULL,
    "noticeOn" TIMESTAMP(3),
    "quorum" TEXT,
    "attendees" JSONB NOT NULL DEFAULT '[]',
    "minutes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compliance_board_meetings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_board_resolutions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "subject" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "passedOn" TIMESTAMP(3) NOT NULL,
    "correctsId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_board_resolutions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_mca_filings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "form" TEXT NOT NULL,
    "fy" TEXT NOT NULL,
    "srn" TEXT,
    "filedOn" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compliance_mca_filings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_stamp_duty_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agreementKind" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "percentOfValue" DECIMAL(6,3),
    "flatAmount" DECIMAL(12,2),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_stamp_duty_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_esign_configs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "apiKeyRef" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compliance_esign_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_document_retention_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "documentKind" TEXT NOT NULL,
    "anchor" TEXT NOT NULL,
    "years" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_document_retention_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_refund_policies" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "rules" JSONB NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_refund_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_refunds" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "invoiceId" TEXT,
    "receiptId" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "requestedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "paidPaymentId" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "compliance_refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_certificates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "verificationCode" TEXT NOT NULL,
    "issuedById" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_certificates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "course_gst_exemptions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "notification" TEXT NOT NULL DEFAULT '12/2017-CT(R) entry 66',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "course_gst_exemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rcm_self_invoices" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "taxableValue" DECIMAL(18,2) NOT NULL,
    "cgstAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "sgstAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "igstAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "rcm_self_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_note_reasons" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "creditNoteId" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_note_reasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "debit_notes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "reasonCode" TEXT NOT NULL,
    "note" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "debit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "einvoice_configs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "credentialsRef" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "einvoice_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gstr2b_imports" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "rows" JSONB NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "importedById" TEXT,

    CONSTRAINT "gstr2b_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gstr2b_matches" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "vendorBillId" TEXT,
    "status" TEXT NOT NULL,
    "difference" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "ctin" TEXT,
    "inum" TEXT,
    "matchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gstr2b_matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gst_rate_tables" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "lateFeePerDayCgst" DECIMAL(8,2) NOT NULL,
    "lateFeePerDaySgst" DECIMAL(8,2) NOT NULL,
    "cap" DECIMAL(10,2) NOT NULL,
    "interestPct" DECIMAL(5,2) NOT NULL,
    "gstr1DueDay" INTEGER NOT NULL DEFAULT 11,
    "gstr3bDueDay" INTEGER NOT NULL DEFAULT 20,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gst_rate_tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_labour_holidays" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "state" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compliance_labour_holidays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_labour_leave_year_closes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "fy" TEXT NOT NULL,
    "balancesClosed" INTEGER NOT NULL DEFAULT 0,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_labour_leave_year_closes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_labour_leave_encashments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "leaveTransactionId" TEXT,
    "days" DECIMAL(6,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "compliance_labour_leave_encashments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_labour_working_hours_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "dailyCapHours" DECIMAL(5,2) NOT NULL,
    "weeklyCapHours" DECIMAL(5,2) NOT NULL,
    "spreadOverHours" DECIMAL(5,2) NOT NULL,
    "otMultiplier" DECIMAL(4,2) NOT NULL,
    "otCapPerQuarterHours" DECIMAL(6,2) NOT NULL,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compliance_labour_working_hours_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_labour_overtime_accruals" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "isoWeek" TEXT NOT NULL,
    "hours" DECIMAL(6,2) NOT NULL,
    "rate" DECIMAL(10,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_labour_overtime_accruals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_labour_icc_members" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "personId" TEXT,
    "externalName" TEXT,
    "role" TEXT NOT NULL,
    "isWoman" BOOLEAN NOT NULL DEFAULT false,
    "appointedOn" TIMESTAMP(3) NOT NULL,
    "termEnds" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compliance_labour_icc_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_labour_posh_complaints" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "complainantPersonId" TEXT,
    "complainantText" TEXT,
    "respondentPersonId" TEXT,
    "respondentText" TEXT,
    "receivedOn" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'received',
    "inquiryDueAt" TIMESTAMP(3) NOT NULL,
    "inquiryClosedAt" TIMESTAMP(3),
    "reportDueAt" TIMESTAMP(3),
    "findings" TEXT,
    "action" TEXT,
    "concealed" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compliance_labour_posh_complaints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_labour_posh_workshops" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "heldOn" TIMESTAMP(3) NOT NULL,
    "topic" TEXT NOT NULL,
    "attendeeCount" INTEGER NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_labour_posh_workshops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_labour_posh_annual_reports" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'prepared',
    "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "preparedById" TEXT,
    "filedAt" TIMESTAMP(3),
    "filedById" TEXT,

    CONSTRAINT "compliance_labour_posh_annual_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_labour_disciplinary_cases" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'show_cause',
    "showCauseIssuedAt" TIMESTAMP(3) NOT NULL,
    "replyDueAt" TIMESTAMP(3) NOT NULL,
    "replyReceivedAt" TIMESTAMP(3),
    "inquiryOfficer" TEXT,
    "inquiryStartedAt" TIMESTAMP(3),
    "decision" TEXT,
    "decidedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compliance_labour_disciplinary_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_labour_hr_letters" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "employmentRelationshipId" TEXT,
    "applicationId" TEXT,
    "number" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedById" TEXT,
    "supersededById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_labour_hr_letters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cmp_pay_pf_rate_tables" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "employeeRate" DECIMAL(6,4) NOT NULL,
    "employerRate" DECIMAL(6,4) NOT NULL,
    "epsRate" DECIMAL(6,4) NOT NULL,
    "edliRate" DECIMAL(6,4) NOT NULL,
    "adminRate" DECIMAL(6,4) NOT NULL,
    "wageCeiling" DECIMAL(10,2) NOT NULL,
    "voluntary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cmp_pay_pf_rate_tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cmp_pay_esi_rate_tables" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "employeeRate" DECIMAL(6,4) NOT NULL,
    "employerRate" DECIMAL(6,4) NOT NULL,
    "wageCeiling" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cmp_pay_esi_rate_tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cmp_pay_pt_slab_tables" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'TN',
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "slabs" JSONB NOT NULL,
    "confirmNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cmp_pay_pt_slab_tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cmp_pay_lwf_rate_tables" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'TN',
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "employeeAmount" DECIMAL(10,2) NOT NULL,
    "employerAmount" DECIMAL(10,2) NOT NULL,
    "dueMonth" INTEGER NOT NULL DEFAULT 12,
    "confirmNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cmp_pay_lwf_rate_tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cmp_pay_minimum_wage_tables" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "monthlyAmount" DECIMAL(10,2) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cmp_pay_minimum_wage_tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cmp_pay_salary_structures" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Proposed',
    "ctcAnnual" DECIMAL(14,2) NOT NULL,
    "basic" DECIMAL(14,2) NOT NULL,
    "hra" DECIMAL(14,2) NOT NULL,
    "specialAllowance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "conveyance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "otherAllowances" JSONB NOT NULL DEFAULT '{}',
    "employerPfMonthly" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "employerEsiMonthly" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "proposedById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cmp_pay_salary_structures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cmp_pay_payslips" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "instructionId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "payPeriod" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cmp_pay_payslips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cmp_pay_gratuity_accruals" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "asOfDate" TIMESTAMP(3) NOT NULL,
    "accrued" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cmp_pay_gratuity_accruals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "privacy_notices" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "body" TEXT NOT NULL,
    "purposes" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'current',
    "supersededById" TEXT,
    "publishedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "privacy_notices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notice_acknowledgements" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "noticeVersion" INTEGER NOT NULL,
    "acknowledgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "channel" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notice_acknowledgements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consents" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "purposeCode" TEXT NOT NULL,
    "noticeVersion" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'granted',
    "grantedAt" TIMESTAMP(3),
    "withdrawnAt" TIMESTAMP(3),
    "channel" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "guardianOfPersonId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_ledger" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "dataPrincipalId" TEXT NOT NULL,
    "consentId" TEXT,
    "purpose" TEXT NOT NULL,
    "noticeVersion" INTEGER,
    "channel" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "givenAt" TIMESTAMP(3),
    "withdrawnAt" TIMESTAMP(3),
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_principal_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'received',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "fulfilledAt" TIMESTAMP(3),
    "refusalReason" TEXT,
    "requestDetail" JSONB,
    "response" JSONB,
    "raisedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "data_principal_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_breaches" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL,
    "description" TEXT NOT NULL,
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "principalsAffected" INTEGER NOT NULL DEFAULT 0,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "boardNotifiedAt" TIMESTAMP(3),
    "principalsNotifiedAt" TIMESTAMP(3),
    "containedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "notes" TEXT,
    "raisedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "data_breaches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retention_schedules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "retentionClass" TEXT NOT NULL,
    "years" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retention_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retention_reports" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retention_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_reviews" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "findings" JSONB NOT NULL,
    "staleCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "encryption_backfill_runs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ranAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fieldsScanned" INTEGER NOT NULL DEFAULT 0,
    "valuesEncrypted" INTEGER NOT NULL DEFAULT 0,
    "alreadyEncrypted" INTEGER NOT NULL DEFAULT 0,
    "runById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "encryption_backfill_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "statutory_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "domain" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "value" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "statutory_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "einvoice_submissions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerInstance" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requestPayload" JSONB NOT NULL,
    "responsePayload" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "irn" TEXT,
    "acknowledgementNumber" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "einvoice_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_statutory_lines" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "payrollRunId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "payPeriod" TEXT NOT NULL,
    "statute" TEXT NOT NULL,
    "contributionKind" TEXT NOT NULL,
    "component" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "ruleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_statutory_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tds_section_rates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "ratePercent" DECIMAL(5,2) NOT NULL,
    "thresholdPerTransaction" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "thresholdPerFy" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "panMissingRatePercent" DECIMAL(5,2) NOT NULL DEFAULT 20,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tds_section_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tds_applicability_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tds_applicability_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tds_decisions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT,
    "certificateRef" TEXT,
    "decidedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tds_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tds_challans" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "sectionGroup" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "deducteeCount" INTEGER NOT NULL DEFAULT 0,
    "bsrCode" TEXT,
    "challanNo" TEXT,
    "paidOn" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "preparedById" TEXT,
    "paidById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tds_challans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_declarations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "fy" TEXT NOT NULL,
    "regime" TEXT NOT NULL DEFAULT 'new',
    "declaredDeductions" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_declarations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "income_tax_slab_tables" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fy" TEXT NOT NULL,
    "regime" TEXT NOT NULL,
    "slabs" JSONB NOT NULL,
    "standardDeduction" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "rebate87ALimit" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "rebate87AMaxAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "cessPercent" DECIMAL(5,2) NOT NULL DEFAULT 4,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "income_tax_slab_tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "corporate_tax_rates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "regime" TEXT NOT NULL DEFAULT '115BAA',
    "effectiveRatePercent" DECIMAL(5,2) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "corporate_tax_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "advance_tax_payments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fy" TEXT NOT NULL,
    "instalmentDate" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "paidOn" TIMESTAMP(3) NOT NULL,
    "reference" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "advance_tax_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tds_returns" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fy" TEXT NOT NULL,
    "quarter" TEXT NOT NULL,
    "form" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'prepared',
    "snapshot" JSONB NOT NULL,
    "token" TEXT,
    "ack" TEXT,
    "preparedById" TEXT,
    "filedById" TEXT,
    "filedAt" TIMESTAMP(3),
    "supersededById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tds_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tds_certificates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "form" TEXT NOT NULL,
    "deducteeRef" TEXT NOT NULL,
    "deducteeName" TEXT NOT NULL,
    "fy" TEXT NOT NULL,
    "quarter" TEXT,
    "snapshot" JSONB NOT NULL,
    "number" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedById" TEXT,
    "supersedesId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tds_certificates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_assets_assets" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "serial" TEXT,
    "purchaseDate" TIMESTAMP(3),
    "cost" DECIMAL(12,2),
    "status" TEXT NOT NULL DEFAULT 'in_stock',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_assets_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_assets_asset_assignments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "issuedOn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "returnedOn" TIMESTAMP(3),
    "condition" TEXT NOT NULL DEFAULT 'good',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_assets_asset_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_assets_travel_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "fromLocation" TEXT NOT NULL,
    "toLocation" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "mode" TEXT NOT NULL,
    "estimatedCost" DECIMAL(12,2) NOT NULL,
    "advanceRequested" DECIMAL(12,2),
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "approverPartyId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "expenseClaimId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_assets_travel_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_assets_letter_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "requestedById" TEXT,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "number" TEXT,
    "hrLetterId" TEXT,
    "snapshot" JSONB,
    "decisionNote" TEXT,
    "fulfilledAt" TIMESTAMP(3),
    "fulfilledById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_assets_letter_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_assets_id_cards" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "cardNumber" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'issued',
    "issuedOn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "returnedOn" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_assets_id_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_compensation_pay_grades" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "minPay" DECIMAL(14,2) NOT NULL,
    "midPay" DECIMAL(14,2) NOT NULL,
    "maxPay" DECIMAL(14,2) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_compensation_pay_grades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_compensation_revision_cycles" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "budgetPct" DECIMAL(6,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "proposedById" TEXT,
    "approvedById" TEXT,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_compensation_revision_cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_compensation_revision_lines" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "currentCtc" DECIMAL(14,2) NOT NULL,
    "proposedPct" DECIMAL(6,2) NOT NULL,
    "proposedCtc" DECIMAL(14,2) NOT NULL,
    "ratingLink" TEXT,
    "approvedCtc" DECIMAL(14,2),
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "proposedById" TEXT,
    "approvedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "compensationRecordId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_compensation_revision_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_compensation_variable_pay_plans" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "formula" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_compensation_variable_pay_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_compensation_variable_payouts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "computedAmount" DECIMAL(14,2) NOT NULL,
    "approvedAmount" DECIMAL(14,2),
    "status" TEXT NOT NULL DEFAULT 'computed',
    "computedById" TEXT,
    "approvedById" TEXT,
    "paidAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_compensation_variable_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_compensation_benefit_plans" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "provider" TEXT,
    "employerContribution" DECIMAL(12,2) NOT NULL,
    "employeeContribution" DECIMAL(12,2) NOT NULL,
    "enrolmentOpensOn" TIMESTAMP(3),
    "enrolmentClosesOn" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_compensation_benefit_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_compensation_benefit_enrollments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "dependants" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'enrolled',
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_compensation_benefit_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_compensation_employee_loans" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "principal" DECIMAL(14,2) NOT NULL,
    "interestPct" DECIMAL(6,2) NOT NULL,
    "tenureMonths" INTEGER NOT NULL,
    "emi" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "requestedById" TEXT,
    "approvedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "disbursedAt" TIMESTAMP(3),
    "startDate" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "outstandingPrincipal" DECIMAL(14,2) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_compensation_employee_loans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_compensation_expense_claims" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "receipts" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "submittedById" TEXT,
    "approvedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "reimbursedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_compensation_expense_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_engagement_announcements" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "audienceType" TEXT NOT NULL DEFAULT 'all',
    "audienceDivision" TEXT,
    "audienceOrgUnitId" TEXT,
    "audienceLocation" TEXT,
    "publishAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "acknowledgementRequired" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_engagement_announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_engagement_announcement_acks" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "announcementId" TEXT NOT NULL,
    "partyId" TEXT NOT NULL,
    "ackedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hcm_engagement_announcement_acks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_engagement_recognitions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "fromPartyId" TEXT NOT NULL,
    "toPartyId" TEXT NOT NULL,
    "badge" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "public" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hcm_engagement_recognitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_engagement_pulse_surveys" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "questions" JSONB NOT NULL,
    "anonymous" BOOLEAN NOT NULL DEFAULT false,
    "opensAt" TIMESTAMP(3) NOT NULL,
    "closesAt" TIMESTAMP(3) NOT NULL,
    "audienceType" TEXT NOT NULL DEFAULT 'all',
    "audienceDivision" TEXT,
    "audienceOrgUnitId" TEXT,
    "audienceLocation" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_engagement_pulse_surveys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_engagement_survey_responses" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "surveyId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT,
    "respondentToken" TEXT,
    "answers" JSONB NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hcm_engagement_survey_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_engagement_survey_response_dedupes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "surveyId" TEXT NOT NULL,
    "dedupeHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hcm_engagement_survey_response_dedupes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_engagement_hr_cases" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "status" TEXT NOT NULL DEFAULT 'open',
    "subject" TEXT NOT NULL,
    "raisedByPartyId" TEXT NOT NULL,
    "assigneePartyId" TEXT,
    "confidential" BOOLEAN NOT NULL DEFAULT false,
    "slaDueAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_engagement_hr_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_engagement_hr_case_messages" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "authorPartyId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hcm_engagement_hr_case_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_engagement_policy_documents" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "acknowledgementRequired" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_engagement_policy_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_engagement_policy_acknowledgements" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "policyDocumentId" TEXT NOT NULL,
    "partyId" TEXT NOT NULL,
    "ackedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hcm_engagement_policy_acknowledgements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_engagement_exit_interviews" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "offboardingId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "questionnaire" JSONB NOT NULL,
    "themes" JSONB NOT NULL DEFAULT '[]',
    "conductedById" TEXT,
    "conductedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hcm_engagement_exit_interviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_learning_training_programs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "provider" TEXT,
    "durationHours" DECIMAL(6,2),
    "cost" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "skillIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "validityMonths" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_learning_training_programs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_learning_training_sessions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "trainer" TEXT,
    "seats" INTEGER NOT NULL DEFAULT 0,
    "location" TEXT,
    "link" TEXT,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_learning_training_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_learning_training_enrollments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'nominated',
    "nominatedById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "score" DECIMAL(5,2),
    "feedback" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_learning_training_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_learning_certifications" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "issuer" TEXT,
    "issuedOn" TIMESTAMP(3) NOT NULL,
    "expiresOn" TIMESTAMP(3),
    "documentRef" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedById" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "sourceEnrollmentId" TEXT,
    "lastExpiryRungDays" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_learning_certifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_learning_mandatory_training_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "applicability" TEXT NOT NULL DEFAULT 'all',
    "dueWithinDaysOfJoin" INTEGER,
    "recurrenceMonths" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_learning_mandatory_training_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_learning_idps" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "goals" JSONB NOT NULL,
    "mentorId" TEXT,
    "reviewDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_learning_idps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_learning_training_budgets" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fy" TEXT NOT NULL,
    "division" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_learning_training_budgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_leavepolicy_policies" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "engagementTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "orgUnitIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "gradeCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_leavepolicy_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_leavepolicy_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "leavePolicyId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "accrualFrequency" TEXT NOT NULL DEFAULT 'monthly',
    "accrualDays" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "prorateOnJoin" BOOLEAN NOT NULL DEFAULT true,
    "maxBalanceDays" DECIMAL(6,2),
    "carryForwardCapDays" DECIMAL(6,2),
    "negativeAllowed" BOOLEAN NOT NULL DEFAULT false,
    "minNoticeDays" INTEGER NOT NULL DEFAULT 0,
    "maxConsecutiveDays" INTEGER,
    "sandwichRule" BOOLEAN NOT NULL DEFAULT false,
    "requiresDocumentAfterDays" INTEGER,
    "applicableGender" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_leavepolicy_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_leavepolicy_accrual_runs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "leavePolicyRuleId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "employeesProcessed" INTEGER NOT NULL DEFAULT 0,
    "totalDaysAccrued" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "hcm_leavepolicy_accrual_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_leavepolicy_approval_chains" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "leavePolicyId" TEXT,
    "levels" JSONB NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_leavepolicy_approval_chains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_leavepolicy_request_approvals" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "leaveRequestId" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "approverPartyId" TEXT,
    "decision" TEXT NOT NULL DEFAULT 'pending',
    "decidedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hcm_leavepolicy_request_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_leavepolicy_restricted_holiday_elections" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "holidayId" TEXT NOT NULL,
    "fy" TEXT NOT NULL,
    "electedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "hcm_leavepolicy_restricted_holiday_elections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_pay_items" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "taxable" BOOLEAN NOT NULL DEFAULT true,
    "statutoryBasis" BOOLEAN NOT NULL DEFAULT false,
    "glAccountCode" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_pay_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_adhoc_pay_lines" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "payItemId" TEXT NOT NULL,
    "payrollRunId" TEXT,
    "payPeriod" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Proposed',
    "proposedById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_adhoc_pay_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_arrears" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "fromPeriod" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Proposed',
    "proposedById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "paidInPayPeriod" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_arrears_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_payroll_journals" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "payrollRunId" TEXT NOT NULL,
    "payPeriod" TEXT NOT NULL,
    "lines" JSONB NOT NULL,
    "totalDebit" DECIMAL(16,2) NOT NULL,
    "totalCredit" DECIMAL(16,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Prepared',
    "transactionId" TEXT,
    "preparedById" TEXT,
    "postedById" TEXT,
    "postedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_payroll_journals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_bank_advices" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "payrollRunId" TEXT NOT NULL,
    "payPeriod" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'NEFT_CSV',
    "fileText" TEXT NOT NULL,
    "rows" JSONB NOT NULL,
    "count" INTEGER NOT NULL,
    "total" DECIMAL(16,2) NOT NULL,
    "generatedById" TEXT,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hcm_bank_advices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_payroll_reconciliations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "payrollRunId" TEXT NOT NULL,
    "previousPayrollRunId" TEXT,
    "deltas" JSONB NOT NULL,
    "unexplainedCount" INTEGER NOT NULL DEFAULT 0,
    "generatedById" TEXT,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hcm_payroll_reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_payroll_calendar" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "payPeriod" TEXT NOT NULL,
    "attendanceLockAt" TIMESTAMP(3) NOT NULL,
    "inputFreezeAt" TIMESTAMP(3) NOT NULL,
    "runByAt" TIMESTAMP(3) NOT NULL,
    "approveByAt" TIMESTAMP(3) NOT NULL,
    "payDate" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_payroll_calendar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_payroll_queries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "payslipId" TEXT,
    "payPeriod" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Open',
    "response" TEXT,
    "respondedById" TEXT,
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_payroll_queries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_performance_review_cycles" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "periodLabel" TEXT NOT NULL,
    "phase" TEXT NOT NULL DEFAULT 'self',
    "startsOn" TIMESTAMP(3) NOT NULL,
    "endsOn" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_performance_review_cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_performance_review_templates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sections" JSONB NOT NULL,
    "ratingScale" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_performance_review_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_performance_review_assignments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "templateId" TEXT,
    "employmentRelationshipId" TEXT NOT NULL,
    "subjectPartyId" TEXT NOT NULL,
    "reviewerEmploymentRelationshipId" TEXT NOT NULL,
    "reviewerPartyId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "dueAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_performance_review_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_performance_review_responses" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "ratings" JSONB NOT NULL,
    "comments" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_performance_review_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_performance_calibration_sessions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "facilitatorPartyId" TEXT,
    "participants" JSONB NOT NULL,
    "decisions" JSONB,
    "status" TEXT NOT NULL DEFAULT 'open',
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_performance_calibration_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_performance_final_ratings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "subjectPartyId" TEXT NOT NULL,
    "rating" TEXT,
    "potential" TEXT,
    "band" TEXT,
    "promotionRecommended" BOOLEAN NOT NULL DEFAULT false,
    "incrementRecommendedPct" DECIMAL(5,2),
    "released" BOOLEAN NOT NULL DEFAULT false,
    "releasedAt" TIMESTAMP(3),
    "releasedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_performance_final_ratings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_performance_feedback" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fromEmploymentRelationshipId" TEXT NOT NULL,
    "fromPartyId" TEXT NOT NULL,
    "toEmploymentRelationshipId" TEXT NOT NULL,
    "toPartyId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_performance_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_performance_one_on_ones" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "managerEmploymentRelationshipId" TEXT NOT NULL,
    "managerPartyId" TEXT NOT NULL,
    "reportEmploymentRelationshipId" TEXT NOT NULL,
    "reportPartyId" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "agenda" JSONB,
    "notes" JSONB,
    "actions" JSONB,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_performance_one_on_ones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_performance_pips" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "subjectPartyId" TEXT NOT NULL,
    "managerEmploymentRelationshipId" TEXT,
    "managerPartyId" TEXT,
    "startsOn" TIMESTAMP(3) NOT NULL,
    "endsOn" TIMESTAMP(3) NOT NULL,
    "objectives" JSONB NOT NULL,
    "checkpoints" JSONB,
    "outcome" TEXT NOT NULL DEFAULT 'open',
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_performance_pips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_performance_succession_plans" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "positionTitle" TEXT NOT NULL,
    "positionId" TEXT,
    "successors" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_performance_succession_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_recruiting_job_postings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "requisitionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'internal',
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "slug" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "closesAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_recruiting_job_postings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_recruiting_candidate_profiles" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'direct',
    "resumeText" TEXT,
    "currentCtc" DECIMAL(14,2),
    "expectedCtc" DECIMAL(14,2),
    "noticeDays" INTEGER,
    "tags" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_recruiting_candidate_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_recruiting_interview_rounds" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "roundNo" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "interviewerPartyIds" JSONB NOT NULL DEFAULT '[]',
    "mode" TEXT NOT NULL DEFAULT 'video',
    "status" TEXT NOT NULL DEFAULT 'Scheduled',
    "outcome" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_recruiting_interview_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_recruiting_interview_scorecards" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "interviewerPartyId" TEXT NOT NULL,
    "competencyScores" JSONB NOT NULL DEFAULT '{}',
    "recommendation" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hcm_recruiting_interview_scorecards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_recruiting_offer_letters" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "ctc" DECIMAL(14,2) NOT NULL,
    "joiningDate" TIMESTAMP(3) NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "proposedByPartyId" TEXT,
    "approvedByPartyId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "declineReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_recruiting_offer_letters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_recruiting_referrals" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "referrerEmploymentId" TEXT NOT NULL,
    "candidatePersonId" TEXT NOT NULL,
    "applicationId" TEXT,
    "bonusAmount" DECIMAL(12,2),
    "status" TEXT NOT NULL DEFAULT 'Submitted',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_recruiting_referrals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_recruiting_background_verifications" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "applicationId" TEXT,
    "employmentId" TEXT,
    "vendor" TEXT NOT NULL,
    "checks" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "outcome" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_recruiting_background_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_recruiting_onboarding_task_templates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'general',
    "assignee" TEXT NOT NULL,
    "dueOffsetDays" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_recruiting_onboarding_task_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_recruiting_onboarding_tasks" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employmentId" TEXT NOT NULL,
    "templateId" TEXT,
    "title" TEXT NOT NULL,
    "assignee" TEXT NOT NULL,
    "assigneePartyId" TEXT,
    "dueDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "completedAt" TIMESTAMP(3),
    "completedByPartyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_recruiting_onboarding_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_sep_resignations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "submittedOn" TIMESTAMP(3) NOT NULL,
    "requestedLastDay" TIMESTAMP(3) NOT NULL,
    "noticeDays" INTEGER NOT NULL,
    "reasonCategory" TEXT NOT NULL,
    "reasonNote" TEXT,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "acceptedById" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "agreedLastDay" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "withdrawnAt" TIMESTAMP(3),
    "offboardingId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_sep_resignations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_sep_notice_policies" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "grade" TEXT,
    "engagementType" TEXT,
    "noticeDays" INTEGER NOT NULL,
    "buyoutAllowed" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_sep_notice_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_sep_exit_clearances" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "offboardingId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "clearedById" TEXT,
    "clearedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_sep_exit_clearances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_sep_no_dues_certificates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "offboardingId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "issuedOn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedById" TEXT NOT NULL,
    "clearanceSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hcm_sep_no_dues_certificates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_sep_alumni_records" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "lastDesignation" TEXT NOT NULL,
    "exitDate" TIMESTAMP(3) NOT NULL,
    "separationType" TEXT NOT NULL,
    "rehireEligible" BOOLEAN,
    "rehireNote" TEXT,
    "contactConsent" BOOLEAN NOT NULL DEFAULT false,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_sep_alumni_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_time_shifts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "graceMinutes" INTEGER NOT NULL DEFAULT 0,
    "breakMinutes" INTEGER NOT NULL DEFAULT 0,
    "nightShift" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_time_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_time_roster_assignments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "weeklyOffDays" INTEGER[] DEFAULT ARRAY[0]::INTEGER[],
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_time_roster_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_time_clock_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'web',
    "ip" TEXT,
    "deviceId" TEXT,
    "lat" DECIMAL(9,6),
    "long" DECIMAL(9,6),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hcm_time_clock_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_time_timesheets" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "recordCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "totalHours" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "submittedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_time_timesheets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_time_timesheet_entries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "timesheetId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "projectId" TEXT,
    "taskRef" TEXT,
    "hours" DECIMAL(5,2) NOT NULL,
    "billable" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_time_timesheet_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_time_overtime_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "hours" DECIMAL(5,2) NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_time_overtime_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_time_comp_offs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "earnedFrom" TEXT NOT NULL,
    "sourceRef" TEXT,
    "earnedOn" TIMESTAMP(3) NOT NULL,
    "days" DECIMAL(3,2) NOT NULL,
    "expiresOn" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'available',
    "consumedOn" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_time_comp_offs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_time_attendance_regularisations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "workAttendanceId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_time_attendance_regularisations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_workflow_request_types" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "approvalChain" JSONB NOT NULL,
    "slaHours" INTEGER NOT NULL DEFAULT 48,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_workflow_request_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_workflow_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "typeId" TEXT NOT NULL,
    "subjectEmploymentId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "currentLevel" INTEGER NOT NULL DEFAULT 1,
    "requestedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "hcm_workflow_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_workflow_request_approvals" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "approverPartyId" TEXT,
    "decision" TEXT NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hcm_workflow_request_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_workflow_delegations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fromPartyId" TEXT NOT NULL,
    "toPartyId" TEXT NOT NULL,
    "fromDate" TIMESTAMP(3) NOT NULL,
    "toDate" TIMESTAMP(3) NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'all',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "hcm_workflow_delegations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_workforce_profile_extensions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "gender" TEXT,
    "maritalStatus" TEXT,
    "nationality" TEXT,
    "passportNumber" TEXT,
    "passportExpiry" TIMESTAMP(3),
    "emergencyContacts" JSONB NOT NULL DEFAULT '[]',
    "currentAddress" JSONB,
    "permanentAddress" JSONB,
    "educationHistory" JSONB NOT NULL DEFAULT '[]',
    "previousEmployment" JSONB NOT NULL DEFAULT '[]',
    "dependants" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_workforce_profile_extensions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_workforce_documents" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedById" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "expiresOn" TIMESTAMP(3),
    "uploadedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_workforce_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_workforce_reporting_lines" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "managerEmploymentRelationshipId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'primary',
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hcm_workforce_reporting_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_workforce_cost_centres" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_workforce_cost_centres_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_workforce_cost_centre_assignments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "costCentreId" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),

    CONSTRAINT "hcm_workforce_cost_centre_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_workforce_locations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'office',
    "city" TEXT,
    "state" TEXT,
    "address" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_workforce_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_workforce_location_assignments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),

    CONSTRAINT "hcm_workforce_location_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_workforce_grades" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_workforce_grades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_workforce_grade_assignments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "gradeId" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),

    CONSTRAINT "hcm_workforce_grade_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hcm_workforce_employee_status_changes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "changes" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending_approval',
    "proposedById" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hcm_workforce_employee_status_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_assets" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "make" TEXT,
    "model" TEXT,
    "serial" TEXT,
    "purchaseDate" TIMESTAMP(3),
    "purchaseCost" DECIMAL(18,2),
    "warrantyEnd" TIMESTAMP(3),
    "supplierName" TEXT,
    "vendorId" TEXT,
    "location" TEXT,
    "division" TEXT,
    "fixedAssetId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'in_stock',
    "condition" TEXT,
    "notes" TEXT,
    "holderPartyId" TEXT,
    "inRepairSince" TIMESTAMP(3),
    "warrantyNotifiedRungs" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "it_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_asset_assignments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "partyId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedById" TEXT,
    "conditionOut" TEXT,
    "returnedAt" TIMESTAMP(3),
    "conditionIn" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "it_asset_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_asset_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "actorPartyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "it_asset_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_asset_thresholds" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL DEFAULT 'DEFAULT',
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "warrantyRungs" INTEGER[] DEFAULT ARRAY[90, 30, 7, 0]::INTEGER[],
    "repairDaysThreshold" INTEGER NOT NULL DEFAULT 14,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "it_asset_thresholds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_continuity_plans" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "applicationName" TEXT NOT NULL,
    "applicationTier" INTEGER NOT NULL,
    "rtoMinutes" INTEGER NOT NULL,
    "rpoMinutes" INTEGER NOT NULL,
    "backupMethod" TEXT NOT NULL,
    "backupFrequency" TEXT NOT NULL,
    "restoreProcedureDocumentId" TEXT,
    "ownerPartyId" TEXT,
    "lastTestedAt" TIMESTAMP(3),
    "testCadenceDays" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "testOverdueNotifiedRungs" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "it_continuity_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_continuity_tests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "testedAt" TIMESTAMP(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "actualRecoveryMinutes" INTEGER,
    "actualDataLossMinutes" INTEGER,
    "notes" TEXT,
    "evidenceDocumentId" TEXT,
    "recordedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "it_continuity_tests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_availability_readings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "applicationName" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "minutesDown" INTEGER NOT NULL DEFAULT 0,
    "incidentCount" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'typed',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "it_availability_readings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_maintenance_windows" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "applicationName" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "changeId" TEXT,
    "notifiedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'planned',
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "it_maintenance_windows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_risk_scoring_bands" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "setId" TEXT NOT NULL,
    "band" TEXT NOT NULL,
    "minScore" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "it_risk_scoring_bands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_risks" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "ownerPartyId" TEXT NOT NULL,
    "likelihoodInherent" INTEGER NOT NULL,
    "impactInherent" INTEGER NOT NULL,
    "scoreInherent" INTEGER NOT NULL,
    "bandInherent" TEXT NOT NULL,
    "likelihoodResidual" INTEGER,
    "impactResidual" INTEGER,
    "scoreResidual" INTEGER,
    "bandResidual" TEXT,
    "scoredUnderBandSetId" TEXT,
    "treatment" TEXT NOT NULL,
    "treatmentPlan" TEXT,
    "reviewDueAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'open',
    "controlIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reviewNotifiedRungs" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "it_risks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_policy_documents" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "drafterPartyId" TEXT NOT NULL,
    "appliesToRoleSlugs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reacknowledgeMonths" INTEGER,
    "publishedAt" TIMESTAMP(3),
    "publishedById" TEXT,
    "supersedesId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "it_policy_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_policy_acknowledgements" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "partyId" TEXT NOT NULL,
    "acknowledgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "it_policy_acknowledgements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_controls" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "frameworkRefs" JSONB NOT NULL,
    "ownerPartyId" TEXT NOT NULL,
    "frequencyDays" INTEGER NOT NULL,
    "lastTestedAt" TIMESTAMP(3),
    "lastResult" TEXT,
    "evidenceDocumentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "testOverdueNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "it_controls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_control_tests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "controlId" TEXT NOT NULL,
    "testedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "result" TEXT NOT NULL,
    "testerPartyId" TEXT NOT NULL,
    "notes" TEXT,
    "evidenceDocumentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "it_control_tests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_access_reviews" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT,
    "name" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scopeRef" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "openedById" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3),
    "overdueNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "it_access_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_access_review_items" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "partyId" TEXT NOT NULL,
    "affiliationId" TEXT,
    "roleSlug" TEXT,
    "applicationId" TEXT,
    "reviewerPartyId" TEXT,
    "decision" TEXT,
    "decidedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "it_access_review_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_remediation_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "days" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "it_remediation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_security_findings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT,
    "title" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "cvss" DECIMAL(3,1),
    "description" TEXT,
    "applicationId" TEXT,
    "assetId" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "changeId" TEXT,
    "overdueNotifiedRungs" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "it_security_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_incidents" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT,
    "title" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'declared',
    "affectedApplicationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "mitigatedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "commanderPartyId" TEXT,
    "impact" TEXT,
    "customerFacing" BOOLEAN NOT NULL DEFAULT false,
    "breachId" TEXT,
    "problemId" TEXT,
    "reviewRequired" BOOLEAN NOT NULL DEFAULT false,
    "reviewBody" TEXT,
    "reviewPublishedAt" TIMESTAMP(3),
    "reviewPublishedById" TEXT,
    "staleNotifiedAt" TIMESTAMP(3),
    "reviewOverdueNotifiedAt" TIMESTAMP(3),
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "it_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_incident_updates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "authorPartyId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "it_incident_updates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_problems" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "rootCause" TEXT,
    "knownError" BOOLEAN NOT NULL DEFAULT false,
    "workaround" TEXT,
    "incidentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ownerPartyId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "it_problems_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_changes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "risk" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "affectedApplicationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "plan" TEXT NOT NULL,
    "rollbackPlan" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "requesterPartyId" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "scheduledAt" TIMESTAMP(3),
    "implementedAt" TIMESTAMP(3),
    "implementationNote" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "rejectionReason" TEXT,
    "failureReason" TEXT,
    "windowMissedNotifiedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "it_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_change_freezes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "allowEmergency" BOOLEAN NOT NULL DEFAULT false,
    "declaredById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "it_change_freezes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_itsm_policies" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "staleMinutes" INTEGER NOT NULL DEFAULT 60,
    "reviewOverdueDays" INTEGER NOT NULL DEFAULT 5,
    "reviewRequiredSeverities" TEXT[] DEFAULT ARRAY['sev1', 'sev2']::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "it_itsm_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_initiatives" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "theme" TEXT NOT NULL,
    "sponsorPartyId" TEXT NOT NULL,
    "ownerPartyId" TEXT NOT NULL,
    "businessCase" TEXT,
    "expectedBenefit" TEXT,
    "budget" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "stage" TEXT NOT NULL DEFAULT 'idea',
    "rag" TEXT NOT NULL DEFAULT 'green',
    "ragReason" TEXT,
    "ragSetAt" TIMESTAMP(3),
    "targetQuarter" TEXT,
    "projectId" TEXT,
    "vendorBillIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "licenceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "staleNotifiedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "it_initiatives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_initiative_updates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "initiativeId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "rag" TEXT NOT NULL,
    "authorPartyId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "it_initiative_updates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_roadmap_items" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "quarter" TEXT NOT NULL,
    "theme" TEXT NOT NULL,
    "initiativeId" TEXT,
    "milestone" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3),
    "done" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "it_roadmap_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_budget_lines" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fy" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "division" TEXT,
    "kind" TEXT NOT NULL,
    "planned" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "bookCategoryIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "burnNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "it_budget_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_tech_debt_items" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "applicationId" TEXT,
    "severity" TEXT NOT NULL,
    "effortDays" INTEGER,
    "interest" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "initiativeId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "it_tech_debt_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_portfolio_settings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "it_portfolio_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_sla_policies" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "responseMinutes" INTEGER NOT NULL,
    "resolutionMinutes" INTEGER NOT NULL,
    "businessHoursOnly" BOOLEAN NOT NULL DEFAULT true,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "it_sla_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_tickets" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT,
    "requesterPartyId" TEXT NOT NULL,
    "assigneePartyId" TEXT,
    "category" TEXT NOT NULL,
    "priority" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "subject" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "assetId" TEXT,
    "applicationId" TEXT,
    "respondDueAt" TIMESTAMP(3),
    "resolveDueAt" TIMESTAMP(3),
    "firstRespondedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "satisfaction" INTEGER,
    "slaBreachNotified" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "waitingSince" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "it_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_ticket_comments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "authorPartyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "it_ticket_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_knowledge_articles" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "applicationId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "helpfulCount" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "it_knowledge_articles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_applications" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT,
    "name" TEXT NOT NULL,
    "vendorName" TEXT,
    "vendorId" TEXT,
    "category" TEXT NOT NULL,
    "tier" INTEGER NOT NULL DEFAULT 3,
    "hosting" TEXT NOT NULL,
    "ownerPartyId" TEXT,
    "dataClassificationHandled" TEXT NOT NULL DEFAULT 'internal',
    "sso" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'evaluating',
    "url" TEXT,
    "notes" TEXT,
    "unownedNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "it_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_licences" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT,
    "applicationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "seatsPurchased" INTEGER NOT NULL DEFAULT 0,
    "seatsInUse" INTEGER NOT NULL DEFAULT 0,
    "costPerPeriod" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "billingCycle" TEXT NOT NULL,
    "termStart" TIMESTAMP(3),
    "termEnd" TIMESTAMP(3),
    "renewalDate" TIMESTAMP(3),
    "noticeDays" INTEGER NOT NULL DEFAULT 30,
    "autoRenew" BOOLEAN NOT NULL DEFAULT false,
    "vendorContractId" TEXT,
    "lastVendorBillId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "renewalNotifiedRungs" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "overAllocationNotifiedAt" TIMESTAMP(3),
    "underUseNotifiedAt" TIMESTAMP(3),
    "pendingRenewalProposedById" TEXT,
    "pendingRenewalApprovalStepId" TEXT,
    "pendingRenewalTermEnd" TIMESTAMP(3),
    "pendingRenewalCostPerPeriod" DECIMAL(18,2),
    "pendingRenewalNote" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "it_licences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_licence_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "licenceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "actorPartyId" TEXT,
    "note" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "it_licence_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_software_thresholds" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "underUsePercent" INTEGER NOT NULL,
    "underUseMinSeats" INTEGER NOT NULL,
    "renewalLadderRungs" INTEGER[],
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "it_software_thresholds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_vendors" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "organizationId" TEXT,
    "category" TEXT NOT NULL,
    "tier" INTEGER NOT NULL DEFAULT 3,
    "riskRating" TEXT NOT NULL DEFAULT 'medium',
    "riskRatedAt" TIMESTAMP(3),
    "assessmentStatus" TEXT NOT NULL DEFAULT 'not_assessed',
    "assessmentDueAt" TIMESTAMP(3),
    "assessmentNotifiedRungs" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "dpaSigned" BOOLEAN NOT NULL DEFAULT false,
    "dpaSignedAt" TIMESTAMP(3),
    "contactName" TEXT,
    "contactEmail" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "it_vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_vendor_assessment_cadence_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "tier" INTEGER NOT NULL,
    "cadenceMonths" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "it_vendor_assessment_cadence_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_vendor_risk_assessments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "assessedAt" TIMESTAMP(3) NOT NULL,
    "assessorPartyId" TEXT NOT NULL,
    "score" INTEGER,
    "outcome" TEXT NOT NULL,
    "questionnaire" JSONB,
    "notes" TEXT,
    "evidenceDocumentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "it_vendor_risk_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_vendor_contracts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "value" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "termMonths" INTEGER,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "noticeDays" INTEGER NOT NULL DEFAULT 30,
    "autoRenew" BOOLEAN NOT NULL DEFAULT false,
    "slaText" TEXT,
    "documentId" TEXT,
    "ownerPartyId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "renewedFromId" TEXT,
    "terminatedAt" TIMESTAMP(3),
    "terminationReason" TEXT,
    "noticeNotifiedRungs" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "it_vendor_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "parentTenantId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'standalone',

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "record_sequences" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "nextSequence" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "record_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_profiles" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "tradeName" TEXT,
    "gstin" TEXT,
    "stateCode" TEXT,
    "stateName" TEXT,
    "pan" TEXT,
    "cin" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "pincode" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "bankName" TEXT,
    "bankAccountName" TEXT,
    "bankAccountNumber" TEXT,
    "bankIfsc" TEXT,
    "bankBranch" TEXT,
    "upiId" TEXT,
    "invoiceTerms" TEXT,
    "invoiceNotes" TEXT,
    "defaultDueDays" INTEGER NOT NULL DEFAULT 30,
    "documentPrefix" TEXT,
    "documentYearFormat" TEXT NOT NULL DEFAULT 'short',
    "incorporatedOn" TIMESTAMP(3),
    "financialYearEndMonth" INTEGER DEFAULT 3,
    "isSmallCompany" BOOLEAN,
    "dematStatus" TEXT NOT NULL DEFAULT 'physical',
    "isin" TEXT,
    "rtaName" TEXT,
    "dpiitNumber" TEXT,
    "dpiitRecognisedOn" TIMESTAMP(3),
    "iac80CertificateRef" TEXT,
    "certificateSignatories" JSONB NOT NULL DEFAULT '[]',
    "boardMeetingsRequiredPerYear" INTEGER,
    "noticeDays" INTEGER NOT NULL DEFAULT 7,
    "tan" TEXT,
    "ptRegistrationNumber" TEXT,
    "pfEstablishmentCode" TEXT,
    "esiEmployerCode" TEXT,
    "udyamNumber" TEXT,
    "compositionScheme" BOOLEAN NOT NULL DEFAULT false,
    "eInvoicingApplicable" BOOLEAN NOT NULL DEFAULT false,
    "grievanceOfficerName" TEXT,
    "grievanceOfficerEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "people" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "primaryPhone" TEXT,
    "primaryEmail" TEXT,
    "primaryPhoneNormalised" TEXT,
    "primaryEmailNormalised" TEXT,
    "additionalPhones" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "additionalEmails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "additionalPhonesNormalised" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "additionalEmailsNormalised" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "externalIds" JSONB NOT NULL DEFAULT '[]',
    "dateOfBirth" TIMESTAMP(3),
    "bloodGroup" TEXT,
    "dedupeStatus" TEXT NOT NULL DEFAULT 'active',
    "mergedIntoId" TEXT,
    "fieldClassifications" JSONB NOT NULL DEFAULT '{}',
    "notes" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "people_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "affiliations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "partyId" TEXT NOT NULL,
    "counterpartyId" TEXT,
    "counterpartyName" TEXT,
    "affiliationType" TEXT NOT NULL,
    "roleSlug" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "primaryFlag" BOOLEAN NOT NULL DEFAULT false,
    "specialisationId" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "priorAffiliationId" TEXT,
    "statutoryRetentionFloor" BOOLEAN NOT NULL DEFAULT false,
    "orgUnitId" TEXT,
    "branch" TEXT,
    "positionId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "affiliations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merge_candidates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "incomingPayload" JSONB NOT NULL,
    "candidatePersonId" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "matchedOn" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "raisedReason" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'open',
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merge_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'organization',
    "roles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "name" TEXT NOT NULL,
    "website" TEXT,
    "parentOrgId" TEXT,
    "locations" JSONB NOT NULL DEFAULT '[]',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ownerPartyId" TEXT,
    "legacyCategory" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "migratedToTenantId" TEXT,
    "spinOutBatchId" TEXT,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tier" TEXT NOT NULL DEFAULT 'standard',
    "ownerPartyId" TEXT,
    "billingEmail" TEXT,
    "billingAddress" TEXT,
    "paymentTermsDays" INTEGER,
    "gstin" TEXT,
    "placeOfSupply" TEXT,
    "annualRevenueBand" TEXT,
    "employeeCountBand" TEXT,
    "attachedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "institution_profiles" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "institutionType" TEXT,
    "managementType" TEXT,
    "address" TEXT,
    "district" TEXT,
    "taluk" TEXT,
    "state" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "externalIdentifier" TEXT,
    "establishedYear" INTEGER,
    "studentCount" INTEGER,
    "departments" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "strategicPriority" TEXT,
    "engagements" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "accreditation" TEXT,
    "attachedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "institution_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_profiles" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "registrationNumber" TEXT,
    "institutionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'prospective',
    "funding" TEXT NOT NULL DEFAULT 'self',
    "sponsorId" TEXT,
    "fundingFramework" TEXT,
    "deliveryLocation" TEXT,
    "address" TEXT,
    "placeOfSupply" TEXT,
    "gstin" TEXT,
    "attachedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "guardianName" TEXT,
    "guardianPhone" TEXT,
    "guardianConsentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "relationships" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fromType" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "toType" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "relationshipType" TEXT NOT NULL,
    "role" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "strength" TEXT NOT NULL DEFAULT 'moderate',
    "ownerPartyId" TEXT,
    "startDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endDate" TIMESTAMP(3),
    "notes" TEXT,
    "supersededById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "relationships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_roles" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "archetype" TEXT NOT NULL DEFAULT 'workspace',
    "classificationCeiling" TEXT NOT NULL DEFAULT 'internal',
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "access_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policies" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "policyCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'permission',
    "currentVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_versions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "authoredById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grants" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "principalType" TEXT NOT NULL DEFAULT 'role',
    "roleId" TEXT,
    "principalId" TEXT,
    "policyVersionId" TEXT,
    "resource" TEXT NOT NULL,
    "verbs" TEXT[],
    "scope" TEXT NOT NULL DEFAULT 'all',
    "scopeResolver" TEXT,
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "authority_grants" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "principalType" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "principalLabel" TEXT,
    "authorityClass" TEXT NOT NULL,
    "ceilingValue" DECIMAL(18,2),
    "currency" TEXT,
    "countCeiling" INTEGER,
    "countWindow" TEXT,
    "riskClassCeiling" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "grantedById" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "authority_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_steps" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "policyId" TEXT,
    "policyVersion" INTEGER,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "subjectLabel" TEXT,
    "action" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestedValue" DECIMAL(18,2),
    "currency" TEXT,
    "resolvedApproverId" TEXT,
    "resolvedApproverRole" TEXT,
    "resolutionTier" INTEGER NOT NULL DEFAULT 0,
    "selfDealingBarTripped" BOOLEAN NOT NULL DEFAULT false,
    "state" TEXT NOT NULL DEFAULT 'open',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "slaDueAt" TIMESTAMP(3),
    "escalatedAt" TIMESTAMP(3),
    "escalationRung" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "decisions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'Raised',
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "subjectLabel" TEXT,
    "authorityBasis" TEXT NOT NULL,
    "requiredAuthorityValue" DECIMAL(18,2),
    "currency" TEXT,
    "routedToPartyId" TEXT,
    "routedToRole" TEXT,
    "evidencePack" JSONB NOT NULL DEFAULT '{}',
    "evidenceComplete" BOOLEAN NOT NULL DEFAULT false,
    "confidence" DOUBLE PRECISION,
    "chosenOption" TEXT,
    "rationale" TEXT,
    "rationaleAudioRef" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "deferUntil" TIMESTAMP(3),
    "pointOfNoReturn" TIMESTAMP(3),
    "reviewDueOn" TIMESTAMP(3),
    "outcomeAssessment" TEXT,
    "varianceBand" TEXT,
    "changeCommitment" TEXT,
    "changeCommitmentResolved" BOOLEAN NOT NULL DEFAULT false,
    "raisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "slaDueAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delegations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "decisionId" TEXT,
    "fromPartyId" TEXT NOT NULL,
    "toPartyId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "returnDueOn" TIMESTAMP(3) NOT NULL,
    "returnedAt" TIMESTAMP(3),
    "returnedUnactioned" BOOLEAN NOT NULL DEFAULT false,
    "state" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delegations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_records" (
    "seq" BIGSERIAL NOT NULL,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "eventVersion" INTEGER NOT NULL DEFAULT 1,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorType" TEXT NOT NULL,
    "actorPartyId" TEXT,
    "actorAccessRole" TEXT,
    "actorAgentId" TEXT,
    "onBehalfOfPartyId" TEXT,
    "subjectEntityType" TEXT NOT NULL,
    "subjectEntityId" TEXT NOT NULL,
    "subjectRecordCode" TEXT,
    "related" JSONB NOT NULL DEFAULT '[]',
    "previousState" JSONB,
    "newState" JSONB,
    "reason" JSONB,
    "source" JSONB NOT NULL DEFAULT '{}',
    "impactDomains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "impactSeverity" TEXT,
    "impactMateriality" JSONB,
    "ownerPartyId" TEXT,
    "ownerPositionId" TEXT,
    "correlationId" TEXT NOT NULL,
    "causationId" TEXT,
    "confidentiality" TEXT NOT NULL DEFAULT 'internal',
    "retentionClass" TEXT NOT NULL DEFAULT 'standard',
    "prevHash" TEXT,
    "hash" TEXT NOT NULL,
    "legacyName" TEXT,

    CONSTRAINT "event_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_dead_letters" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "eventRecordId" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "subscriberKey" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'dead',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "replayedAt" TIMESTAMP(3),

    CONSTRAINT "event_dead_letters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_claims" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "jobName" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'claimed',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3) NOT NULL,
    "heartbeatAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "lastError" TEXT,
    "deadAt" TIMESTAMP(3),

    CONSTRAINT "job_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_records" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "actorType" TEXT NOT NULL DEFAULT 'human',
    "actorId" TEXT,
    "actorLabel" TEXT,
    "actorAgentId" TEXT,
    "diff" JSONB,
    "fieldsRead" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "meta" JSONB,
    "hash" TEXT,
    "prevHash" TEXT,
    "retentionClass" TEXT NOT NULL DEFAULT 'audit_record',
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "branch" TEXT,
    "passwordHash" TEXT,
    "principalId" TEXT,
    "activeAffiliationId" TEXT,
    "lastLoginAt" TIMESTAMP(3),
    "mfaSecret" TEXT,
    "mfaEnabledAt" TIMESTAMP(3),
    "passwordChangedAt" TIMESTAMP(3),
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "principals" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "principals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jti" TEXT NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "userAgent" TEXT,
    "ip" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attention_watermarks" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "affiliationId" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reachSignature" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attention_watermarks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pipeline_definitions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "pipelineCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "commercialMotion" TEXT NOT NULL,
    "appliesToVerticals" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "appliesToAccountKind" TEXT NOT NULL DEFAULT 'any',
    "defaultForecastMethod" TEXT NOT NULL DEFAULT 'weighted_stage',
    "requiresAwardArtefact" TEXT NOT NULL DEFAULT 'none',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "commitApprovalThreshold" DECIMAL(18,2),
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pipeline_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pipeline_stages" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "pipelineId" TEXT NOT NULL,
    "stageKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "defaultProbability" INTEGER NOT NULL DEFAULT 0,
    "pipelinePosition" INTEGER NOT NULL,
    "isOpen" BOOLEAN NOT NULL DEFAULT true,
    "isTerminal" BOOLEAN NOT NULL DEFAULT false,
    "postAward" BOOLEAN NOT NULL DEFAULT false,
    "stageAgeBudgetDays" INTEGER,
    "requiredFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "entryPredicate" JSONB NOT NULL DEFAULT '{}',
    "exitPredicate" JSONB NOT NULL DEFAULT '{}',
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pipeline_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pipeline_transitions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "pipelineId" TEXT NOT NULL,
    "fromStageKey" TEXT,
    "toStageKey" TEXT NOT NULL,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "requiredPermission" TEXT NOT NULL DEFAULT 'opportunities:edit',
    "emitsEvent" TEXT NOT NULL DEFAULT 'kz.crm.opportunity.stage_changed',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pipeline_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "territories" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "geoAreaRef" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "appliesToVerticals" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "appliesToAccountKind" TEXT NOT NULL DEFAULT 'any',
    "ownerPositionId" TEXT,
    "ownerPartyId" TEXT,
    "capacityCeiling" INTEGER NOT NULL DEFAULT 50,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "territories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "routing_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "factorWeights" JSONB NOT NULL DEFAULT '{"capacity":30,"capability":25,"relationship_strength":30,"round_robin":15}',
    "tieBreakMarginPoints" INTEGER NOT NULL DEFAULT 5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "routing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "routing_audits" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "territoryId" TEXT,
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "candidates" JSONB NOT NULL,
    "winnerPartyId" TEXT,
    "unroutedReason" TEXT,

    CONSTRAINT "routing_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capability_claims" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "partyId" TEXT NOT NULL,
    "offeringId" TEXT,
    "vertical" TEXT,
    "skillId" TEXT,
    "tier" TEXT NOT NULL DEFAULT 'claimed',
    "confidenceRank" INTEGER NOT NULL DEFAULT 2,
    "confidenceScore" DECIMAL(4,3) NOT NULL DEFAULT 0.5,
    "claimedProficiencyLevel" INTEGER,
    "state" TEXT NOT NULL DEFAULT 'active',
    "source" TEXT NOT NULL DEFAULT 'self_report_or_cv_parse',
    "lastEvidencedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "evidence" TEXT,
    "assertedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "capability_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "personId" TEXT,
    "organizationId" TEXT,
    "vertical" TEXT NOT NULL,
    "offeringId" TEXT,
    "legacyProductText" TEXT,
    "pipelineId" TEXT NOT NULL,
    "stageKey" TEXT NOT NULL,
    "stageEnteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "legacyStage" TEXT,
    "legacyVerticalStage" TEXT,
    "leadStatus" TEXT NOT NULL DEFAULT 'open',
    "ownerPartyId" TEXT,
    "territoryId" TEXT,
    "unroutedReason" TEXT,
    "routedAt" TIMESTAMP(3),
    "score" INTEGER NOT NULL DEFAULT 0,
    "scoreReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source" TEXT NOT NULL DEFAULT 'manual',
    "sourceDetail" TEXT,
    "estimatedValue" DECIMAL(18,2),
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "lastInteractionAt" TIMESTAMP(3),
    "untouchedNotifiedAt" TIMESTAMP(3),
    "convertedOpportunityId" TEXT,
    "campaignId" TEXT,
    "channelKey" TEXT,
    "utm" JSONB,
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opportunities" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "accountId" TEXT,
    "organizationId" TEXT,
    "primaryContactPersonId" TEXT,
    "leadId" TEXT,
    "vertical" TEXT NOT NULL,
    "offeringId" TEXT,
    "legacyProductText" TEXT,
    "pipelineId" TEXT NOT NULL,
    "stageKey" TEXT NOT NULL,
    "stageEnteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "legacyStage" TEXT,
    "forecastCategory" TEXT NOT NULL DEFAULT 'pipeline',
    "forecastCategoryChangedAt" TIMESTAMP(3),
    "forecastCategoryChangeReason" TEXT,
    "expectedValue" DECIMAL(18,2),
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "expectedCloseDate" TIMESTAMP(3),
    "ownerPartyId" TEXT,
    "strategicValue" TEXT,
    "proposalId" TEXT,
    "proposalSentAt" TIMESTAMP(3),
    "proposalPendingNotifiedAt" TIMESTAMP(3),
    "quoteId" TEXT,
    "contractId" TEXT,
    "mouId" TEXT,
    "parentContractId" TEXT,
    "outcome" TEXT,
    "lostReason" TEXT,
    "closedAt" TIMESTAMP(3),
    "stageAgeNotifiedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "opportunities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offerings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "offeringCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "vertical" TEXT NOT NULL,
    "deliveryModel" TEXT NOT NULL,
    "defaultRevenueTreatment" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "owningBusinessUnit" TEXT,
    "legacyProductStrings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "createdById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "offerings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_book_entries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "priceBookId" TEXT NOT NULL DEFAULT 'standard',
    "priceBookName" TEXT NOT NULL DEFAULT 'Standard List',
    "currency" TEXT NOT NULL,
    "unitPrice" DECIMAL(18,2) NOT NULL,
    "billingFrequency" TEXT NOT NULL,
    "minQuantity" INTEGER NOT NULL DEFAULT 1,
    "maxDiscountPct" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 1,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "price_book_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proposals" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "quoteId" TEXT,
    "title" TEXT NOT NULL,
    "totalValue" DECIMAL(18,2),
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "documentId" TEXT,
    "sentAt" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "response" TEXT NOT NULL DEFAULT 'pending',
    "respondedAt" TIMESTAMP(3),
    "stalledNotifiedAt" TIMESTAMP(3),
    "ownerPartyId" TEXT,
    "createdById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "subtotal" DECIMAL(18,2),
    "discountTotal" DECIMAL(18,2),
    "grandTotal" DECIMAL(18,2),
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "issuedAt" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "blockedReason" TEXT,
    "approvalStepId" TEXT,
    "ownerPartyId" TEXT,
    "createdById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_lines" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "quote_id" TEXT NOT NULL,
    "priceBookEntryId" TEXT NOT NULL,
    "priceBookEntryVersion" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "listUnitPrice" DECIMAL(18,2) NOT NULL,
    "discountPct" INTEGER NOT NULL DEFAULT 0,
    "discountAmount" DECIMAL(18,2),
    "lineTotal" DECIMAL(18,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mous" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "legacyReference" TEXT,
    "title" TEXT NOT NULL,
    "organizationId" TEXT,
    "institutionId" TEXT,
    "opportunityId" TEXT,
    "ownerPartyId" TEXT,
    "documentId" TEXT,
    "scope" TEXT,
    "vertical" TEXT,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "commercialValue" DECIMAL(18,2),
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "strategicValue" TEXT,
    "termMonths" INTEGER,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "signedDate" TIMESTAMP(3),
    "renewedFromId" TEXT,
    "expiryNotifiedDays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "signedById" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mous_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contracts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "organizationId" TEXT,
    "accountId" TEXT,
    "institutionId" TEXT,
    "opportunityId" TEXT,
    "quoteId" TEXT,
    "ownerPartyId" TEXT,
    "documentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "commercialValue" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "strategicValue" TEXT,
    "termMonths" INTEGER,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "signedDate" TIMESTAMP(3),
    "renewedFromId" TEXT,
    "expiryNotifiedDays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "terminatedAt" TIMESTAMP(3),
    "terminationReason" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "signedById" TEXT,
    "createdById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_agreements" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "partnerOrganizationId" TEXT NOT NULL,
    "relationshipId" TEXT,
    "agreementType" TEXT NOT NULL,
    "scope" TEXT,
    "territoryScope" TEXT,
    "commercialTermsRef" TEXT,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "commercialValue" DECIMAL(18,2),
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "strategicValue" TEXT,
    "termMonths" INTEGER,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "signedDate" TIMESTAMP(3),
    "renewedFromId" TEXT,
    "expiryNotifiedDays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "ownerPartyId" TEXT,
    "documentId" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partner_agreements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "win_loss_reviews" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "subjectLabel" TEXT,
    "outcome" TEXT NOT NULL,
    "competitorName" TEXT,
    "decisionMakerPersonId" TEXT,
    "realLostStage" TEXT,
    "lostReason" TEXT,
    "lostReasonOtherText" TEXT,
    "lesson" TEXT,
    "mandatory" BOOLEAN NOT NULL DEFAULT false,
    "mandatoryBasis" TEXT NOT NULL DEFAULT 'not_mandatory',
    "strategicValueSnapshot" TEXT,
    "commercialValueSnapshot" DECIMAL(18,2),
    "thresholdUsedSnapshot" DECIMAL(18,2),
    "completedById" TEXT,
    "completedAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "overdueNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "win_loss_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interactions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "interactionType" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'outbound',
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "actorPartyId" TEXT,
    "participantPartyIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "durationMinutes" INTEGER,
    "subject" TEXT,
    "notes" TEXT,
    "outcome" TEXT,
    "relatedReferences" JSONB NOT NULL,
    "sensitivityClass" TEXT NOT NULL DEFAULT 'internal',
    "nextAction" TEXT,
    "nextActionDue" TIMESTAMP(3),
    "attachmentDocumentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "messageIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sensitivity_registrations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contextCode" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "sensitivityClass" TEXT NOT NULL,
    "registeredById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sensitivity_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "assigneePartyId" TEXT,
    "ownerPartyId" TEXT,
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "relatedInteractionId" TEXT,
    "relatedType" TEXT,
    "relatedId" TEXT,
    "escalatedAt" TIMESTAMP(3),
    "overdueNotifiedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "attachedToType" TEXT NOT NULL,
    "attachedToId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "documentGroupId" TEXT NOT NULL,
    "documentKind" TEXT NOT NULL DEFAULT 'file_artefact',
    "label" TEXT,
    "sensitivityClass" TEXT NOT NULL DEFAULT 'internal',
    "uploadedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "retainUntil" TIMESTAMP(3),
    "stampDutyAmount" DECIMAL(14,2),
    "stampDutyRef" TEXT,
    "eSignProvider" TEXT,
    "eSignRef" TEXT,
    "eSignedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "attachedToType" TEXT NOT NULL,
    "attachedToId" TEXT NOT NULL,
    "authorPartyId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "share_classes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "instrument" TEXT NOT NULL,
    "faceValue" DECIMAL(18,2) NOT NULL,
    "votesPerShare" DECIMAL(24,6) NOT NULL DEFAULT 1,
    "rights" JSONB NOT NULL DEFAULT '{}',
    "conversionTerms" JSONB,
    "redemptionTerms" JSONB,
    "authorisedCount" DECIMAL(24,6),
    "status" TEXT NOT NULL DEFAULT 'active',
    "spinOutBatchId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "share_classes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holders" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "personId" TEXT,
    "organizationId" TEXT,
    "heldByTenantId" TEXT,
    "folioNumber" TEXT NOT NULL,
    "residency" TEXT NOT NULL DEFAULT 'resident',
    "investmentBasis" TEXT,
    "panNumber" TEXT,
    "nominee" JSONB,
    "jointHolders" JSONB,
    "status" TEXT NOT NULL DEFAULT 'active',
    "address" TEXT,
    "occupation" TEXT,
    "nationality" TEXT,
    "guardianOrSpouseName" TEXT,
    "dematAccount" JSONB,
    "spinOutBatchId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "holders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "share_transactions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "shareClassId" TEXT NOT NULL,
    "fromHolderId" TEXT,
    "toHolderId" TEXT,
    "count" DECIMAL(24,6) NOT NULL,
    "pricePerShare" DECIMAL(18,2),
    "distinctiveFrom" BIGINT,
    "distinctiveTo" BIGINT,
    "effectiveOn" TIMESTAMP(3) NOT NULL,
    "roundId" TEXT,
    "fromShareClassId" TEXT,
    "extinguishedOn" TIMESTAMP(3),
    "considerationTransactionId" TEXT,
    "approvalDecisionId" TEXT,
    "boardResolutionRef" TEXT,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "reversalOfId" TEXT,
    "reversedById" TEXT,
    "proposedByPartyId" TEXT NOT NULL,
    "note" TEXT,
    "documents" JSONB NOT NULL DEFAULT '[]',
    "meta" JSONB,
    "spinOutBatchId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "share_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "share_certificates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "certificateNumber" TEXT NOT NULL,
    "imported" BOOLEAN NOT NULL DEFAULT false,
    "holderId" TEXT NOT NULL,
    "shareClassId" TEXT NOT NULL,
    "distinctiveFrom" BIGINT NOT NULL,
    "distinctiveTo" BIGINT NOT NULL,
    "count" DECIMAL(24,6) NOT NULL,
    "issuedOn" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'issued',
    "supersededById" TEXT,
    "issuedForTransactionId" TEXT,
    "signatories" JSONB NOT NULL DEFAULT '[]',
    "holderNameSnapshot" TEXT NOT NULL,
    "stampDutyPaid" DECIMAL(18,2),
    "stampDutyPaidOn" TIMESTAMP(3),
    "spinOutBatchId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "share_certificates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "valuations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "basis" TEXT NOT NULL,
    "valuerName" TEXT,
    "perShareByClass" JSONB NOT NULL,
    "equityValue" DECIMAL(18,2),
    "reportRef" TEXT,
    "validUntil" TIMESTAMP(3),
    "note" TEXT,
    "roundId" TEXT,
    "createdById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "valuations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "funding_rounds" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "openedOn" TIMESTAMP(3),
    "closedOn" TIMESTAMP(3),
    "preMoneyValuation" DECIMAL(18,2),
    "postMoneyValuation" DECIMAL(18,2),
    "raised" DECIMAL(18,2),
    "pricePerShareByClass" JSONB,
    "valuationId" TEXT,
    "boardResolutionRef" TEXT,
    "shareholderResolutionRef" TEXT,
    "mgt14Srn" TEXT,
    "pas3Srn" TEXT,
    "pas3FiledOn" TIMESTAMP(3),
    "offerLetterSerial" TEXT,
    "separateBankAccountRef" TEXT,
    "offereeCount" INTEGER,
    "renunciationAllowed" BOOLEAN,
    "sourceOfBonus" TEXT,
    "valuationReportRef" TEXT,
    "tribunalOrderRef" TEXT,
    "notes" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "funding_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "filings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "form" TEXT NOT NULL,
    "relatedType" TEXT,
    "relatedId" TEXT,
    "periodOrEvent" TEXT NOT NULL,
    "srn" TEXT,
    "filedOn" TIMESTAMP(3),
    "dueOn" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'due',
    "note" TEXT,
    "recordedByPartyId" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "filings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_documents" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "fileRef" TEXT NOT NULL,
    "uploadedByPartyId" TEXT NOT NULL,
    "relatedType" TEXT,
    "relatedId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "entity_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_snapshots" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "sourceTenantId" TEXT NOT NULL,
    "sourceSlug" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "originDivision" TEXT,
    "asOf" TIMESTAMP(3) NOT NULL,
    "sourceEventHash" TEXT,
    "capTable" JSONB NOT NULL,
    "shareClasses" JSONB NOT NULL,
    "board" JSONB NOT NULL,
    "financial" JSONB NOT NULL,
    "compliance" JSONB NOT NULL,
    "valuation" JSONB,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "entity_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_snapshot_history" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "sourceTenantId" TEXT NOT NULL,
    "sourceSlug" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "originDivision" TEXT,
    "asOf" TIMESTAMP(3) NOT NULL,
    "sourceEventHash" TEXT,
    "capTable" JSONB NOT NULL,
    "shareClasses" JSONB NOT NULL,
    "board" JSONB NOT NULL,
    "financial" JSONB NOT NULL,
    "compliance" JSONB NOT NULL,
    "valuation" JSONB,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_snapshot_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "esop_plans" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "poolShareClassId" TEXT NOT NULL,
    "targetShareClassId" TEXT NOT NULL,
    "approvedOn" TIMESTAMP(3),
    "resolutionRef" TEXT,
    "mgt14Srn" TEXT,
    "isDpiitRecognised" BOOLEAN NOT NULL DEFAULT false,
    "exercisePriceDefault" DECIMAL(18,2),
    "vestingDefault" JSONB NOT NULL,
    "exerciseWindowMonthsAfterExit" INTEGER NOT NULL DEFAULT 3,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "esop_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "option_grants" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "employmentId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "grantedOn" TIMESTAMP(3) NOT NULL,
    "count" DECIMAL(24,6) NOT NULL,
    "exercisePrice" DECIMAL(18,2) NOT NULL,
    "vesting" JSONB NOT NULL,
    "grantLetterRef" TEXT,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "vested" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "exercised" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "lapsed" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "lapsedOn" TIMESTAMP(3),
    "lapseReason" TEXT,
    "exerciseWindowEndsOn" TIMESTAMP(3),
    "promoterCheck" JSONB NOT NULL,
    "resolutionRef" TEXT,
    "proposedByPartyId" TEXT NOT NULL,
    "approvedByPartyId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "option_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vesting_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "on" TIMESTAMP(3) NOT NULL,
    "count" DECIMAL(24,6) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "vestedOn" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vesting_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "option_exercises" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "requestedOn" TIMESTAMP(3) NOT NULL,
    "count" DECIMAL(24,6) NOT NULL,
    "exercisePrice" DECIMAL(18,2) NOT NULL,
    "fmvPerShare" DECIMAL(18,2),
    "fmvBasis" TEXT NOT NULL DEFAULT 'none',
    "fmvValuationId" TEXT,
    "perquisite" DECIMAL(18,2),
    "perquisiteNote" TEXT,
    "taxDeferred" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "allotmentTransactionId" TEXT,
    "paidReference" TEXT,
    "requestedByPartyId" TEXT NOT NULL,
    "approvedByPartyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "option_exercises_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT,
    "draftReference" TEXT,
    "accountId" TEXT,
    "organizationId" TEXT,
    "contractId" TEXT,
    "opportunityId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "issuedDate" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "enrollmentDate" TIMESTAMP(3),
    "taxRegistrationReference" TEXT,
    "placeOfSupply" TEXT,
    "interState" BOOLEAN NOT NULL DEFAULT false,
    "customerGstin" TEXT,
    "taxableValue" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "cgstAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "sgstAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "igstAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "roundOff" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "grandTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "division" TEXT,
    "personId" TEXT,
    "paymentType" TEXT NOT NULL DEFAULT 'credit',
    "amountPayableNow" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "paymentMode" TEXT,
    "paymentReference" TEXT,
    "notes" TEXT,
    "gstFilingId" TEXT,
    "overdueNotifiedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "invoiceType" TEXT NOT NULL DEFAULT 'tax_invoice',
    "reverseCharge" BOOLEAN NOT NULL DEFAULT false,
    "irn" TEXT,
    "irnAckNo" TEXT,
    "irnAckAt" TIMESTAMP(3),
    "signedQrCode" TEXT,
    "eInvoiceStatus" TEXT NOT NULL DEFAULT 'not_applicable',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_lines" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "offeringId" TEXT,
    "courseId" TEXT,
    "enrollmentId" TEXT,
    "courseAddonId" TEXT,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "amount" DECIMAL(18,2) NOT NULL,
    "discountAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "discountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "position" INTEGER NOT NULL DEFAULT 0,
    "revenueMethod" TEXT NOT NULL,
    "hsnSac" TEXT,
    "gstRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "supplyType" TEXT NOT NULL DEFAULT 'taxable',
    "exemptionNotification" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_instalments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "feePlanId" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "dueDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "overdueNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fee_instalments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "gatewayReference" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'received',
    "method" TEXT NOT NULL DEFAULT 'bank_transfer',
    "bankAccountReference" TEXT,
    "payerOrganizationId" TEXT,
    "payerPersonId" TEXT,
    "reversalOfPaymentId" TEXT,
    "note" TEXT,
    "recordedById" TEXT,
    "pendingLastNotifiedAt" TIMESTAMP(3),
    "foreignCurrency" TEXT,
    "foreignAmount" DECIMAL(18,2),
    "fircNumber" TEXT,
    "fircDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "feeInstalmentId" TEXT,
    "allocatedAmount" DECIMAL(18,2) NOT NULL,
    "allocatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "allocatedById" TEXT,
    "subjectTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "balanceAfter" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "paymentMode" TEXT,
    "paymentReference" TEXT,
    "note" TEXT,
    "legacyReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "final_invoices" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedById" TEXT,
    "totalPayable" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalReceived" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "creditNoted" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "balance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "settled" BOOLEAN NOT NULL DEFAULT false,
    "receiptCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "receiptCount" INTEGER NOT NULL DEFAULT 0,
    "snapshot" JSONB NOT NULL,
    "supersededById" TEXT,
    "status" TEXT NOT NULL DEFAULT 'issued',
    "triggerReason" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "final_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_notes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "reason" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gst_filings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "returnType" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "gstin" TEXT,
    "status" TEXT NOT NULL DEFAULT 'prepared',
    "snapshot" JSONB NOT NULL,
    "taxableValue" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "cgstAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "sgstAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "igstAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "inputTaxCredit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "netPayable" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "invoiceCount" INTEGER NOT NULL DEFAULT 0,
    "preparedById" TEXT,
    "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "arn" TEXT,
    "filedAt" TIMESTAMP(3),
    "filedById" TEXT,
    "supersededById" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gst_filings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receivables_projections" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "subjectLabel" TEXT,
    "amountOutstanding" DECIMAL(18,2),
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "nextDueDate" TIMESTAMP(3),
    "dunningStage" TEXT,
    "hydratedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receivables_projections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "courses" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "durationWeeks" INTEGER,
    "offeringId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "feeAmount" DECIMAL(18,2),
    "feePlan" JSONB,
    "gstRate" DECIMAL(5,2) NOT NULL DEFAULT 18,
    "hsnSac" TEXT,
    "hours" DECIMAL(6,1),
    "division" TEXT NOT NULL DEFAULT 'education',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "migratedToTenantId" TEXT,
    "spinOutBatchId" TEXT,

    CONSTRAINT "courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "course_fee_plans" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "tenureMonths" INTEGER NOT NULL,
    "monthlyFee" DECIMAL(18,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "course_fee_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "course_addons" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(18,2) NOT NULL,
    "gstRate" DECIMAL(5,2) NOT NULL DEFAULT 18,
    "hsnSac" TEXT,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "course_addons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cohorts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "trainerPartyId" TEXT,
    "institutionId" TEXT,
    "capacity" INTEGER NOT NULL DEFAULT 30,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "migratedToTenantId" TEXT,
    "spinOutBatchId" TEXT,

    CONSTRAINT "cohorts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrollments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "legacyReference" TEXT,
    "personId" TEXT NOT NULL,
    "cohortId" TEXT NOT NULL,
    "institutionId" TEXT,
    "opportunityId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'reserved',
    "enrolledAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "progressPct" INTEGER NOT NULL DEFAULT 0,
    "attendancePct" INTEGER NOT NULL DEFAULT 100,
    "atRisk" BOOLEAN NOT NULL DEFAULT false,
    "atRiskNotifiedAt" TIMESTAMP(3),
    "guardianName" TEXT,
    "guardianPhone" TEXT,
    "guardianEmail" TEXT,
    "isMinor" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "migratedToTenantId" TEXT,
    "spinOutBatchId" TEXT,

    CONSTRAINT "enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendances" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "sessionDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "recordedById" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_progresses" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "progressDate" TIMESTAMP(3) NOT NULL,
    "score" INTEGER,
    "note" TEXT,
    "recordedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_progresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learner_logs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "entryDate" TIMESTAMP(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "severity" TEXT,
    "rating" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolutionNote" TEXT,
    "recordedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "learner_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "organizationId" TEXT,
    "opportunityId" TEXT,
    "contractId" TEXT,
    "managerPartyId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "startDate" TIMESTAMP(3),
    "targetEndDate" TIMESTAMP(3),
    "actualEndDate" TIMESTAMP(3),
    "healthBand" TEXT NOT NULL DEFAULT 'stable',
    "scheduleVariancePct" INTEGER NOT NULL DEFAULT 0,
    "handoffAcceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exception_records" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'open',
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "subjectLabel" TEXT,
    "domain" TEXT NOT NULL DEFAULT 'crm',
    "detail" TEXT,
    "reasonCode" TEXT,
    "ownerPartyId" TEXT,
    "accountablePositionId" TEXT,
    "ownerUnresolved" BOOLEAN NOT NULL DEFAULT false,
    "raisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolutionNote" TEXT,
    "slaDueAt" TIMESTAMP(3),
    "escalatedAt" TIMESTAMP(3),
    "escalationRung" INTEGER NOT NULL DEFAULT 0,
    "escalationTrigger" TEXT,
    "escalatedToPartyId" TEXT,
    "triggerFingerprint" TEXT,
    "ladderRung" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "exception_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recipientPartyId" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'N2_NORMAL',
    "channel" TEXT NOT NULL DEFAULT 'in_app',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "severity" TEXT,
    "subjectType" TEXT,
    "subjectId" TEXT,
    "drillPath" TEXT,
    "readAt" TIMESTAMP(3),
    "dispatchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_definitions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "jobName" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "automationClass" TEXT NOT NULL,
    "cronExpression" TEXT NOT NULL DEFAULT '0 * * * *',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "accountablePositionId" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_runs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "automationVersionId" TEXT NOT NULL,
    "jobName" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'running',
    "processed" INTEGER NOT NULL DEFAULT 0,
    "notified" INTEGER NOT NULL DEFAULT 0,
    "skippedIdempotent" INTEGER NOT NULL DEFAULT 0,
    "errors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dryRun" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_firing_logs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "automationVersionId" TEXT NOT NULL,
    "subjectRef" TEXT NOT NULL,
    "triggerFingerprint" TEXT NOT NULL,
    "ladderRung" INTEGER NOT NULL DEFAULT 0,
    "jobRunId" TEXT,
    "firedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome" TEXT NOT NULL DEFAULT 'executed',

    CONSTRAINT "job_firing_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_principals" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agentKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "declaredTools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_principals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_actions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "proposal" JSONB NOT NULL,
    "rationale" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'proposed',
    "blockedReason" TEXT,
    "onBehalfOfPartyId" TEXT,
    "humanActorId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "proposedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kpi_readings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "domainCode" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "dimensions" JSONB NOT NULL DEFAULT '{}',
    "value" DOUBLE PRECISION NOT NULL,
    "target" DOUBLE PRECISION,
    "asOf" TIMESTAMP(3) NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kpi_readings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "health_scores" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "domainCode" TEXT NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "score" DOUBLE PRECISION,
    "band" TEXT,
    "factors" JSONB NOT NULL DEFAULT '[]',
    "state" TEXT NOT NULL DEFAULT 'measured',
    "policyVersionId" TEXT,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "health_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_metrics" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "metric" TEXT NOT NULL,
    "dimensions" JSONB NOT NULL DEFAULT '{}',
    "value" DOUBLE PRECISION NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retired" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "daily_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lessons" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "domain" TEXT NOT NULL DEFAULT 'crm',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lessons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "narratives" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "forUserId" TEXT NOT NULL,
    "windowFrom" TIMESTAMP(3) NOT NULL,
    "windowTo" TIMESTAMP(3) NOT NULL,
    "reconciliationLine" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "claimRefs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "narratives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "surface_templates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "templateKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "archetype" TEXT NOT NULL,
    "eligibleRoles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "navGroup" TEXT NOT NULL DEFAULT 'main',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "surface_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "widget_definitions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "widgetKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "dataSource" TEXT NOT NULL,
    "requiredPermission" TEXT NOT NULL,
    "severityRelevance" TEXT NOT NULL DEFAULT 'S0_INFO',
    "actions" JSONB NOT NULL DEFAULT '[]',
    "drillTarget" TEXT NOT NULL,
    "mobileBehaviour" TEXT NOT NULL DEFAULT 'keep',
    "emptyState" TEXT NOT NULL,
    "noActionFallback" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "widget_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "widget_bindings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "widgetId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "personalisationPolicy" TEXT NOT NULL DEFAULT 'movable',
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "widget_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nav_nodes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "nodeKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "icon" TEXT NOT NULL DEFAULT 'circle',
    "path" TEXT NOT NULL,
    "group" TEXT NOT NULL DEFAULT 'main',
    "parentKey" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "requiredPermission" TEXT,
    "eligibleArchetypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "searchSynonyms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nav_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "surface_compositions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "affiliationId" TEXT NOT NULL,
    "templateKey" TEXT NOT NULL,
    "templateVersion" INTEGER NOT NULL,
    "policyVersionId" TEXT,
    "widgets" JSONB NOT NULL DEFAULT '[]',
    "withheld" JSONB NOT NULL DEFAULT '[]',
    "composedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "surface_compositions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "thresholds" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "thresholdKey" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'count',
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "thresholds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_units" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unitType" TEXT NOT NULL DEFAULT 'team',
    "division" TEXT,
    "parentId" TEXT,
    "headPositionId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "jobFamily" TEXT NOT NULL,
    "jobLevel" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "orgUnitId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "location" TEXT NOT NULL DEFAULT 'Head Office',
    "reportingPositionId" TEXT,
    "isLeadPosition" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'Requested',
    "budgetLineId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employment_relationships" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "legalEntity" TEXT NOT NULL DEFAULT 'Kaizen Infinities Pvt Ltd',
    "hireEffectiveDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PendingHire',
    "confirmationState" TEXT NOT NULL DEFAULT 'not_applicable',
    "separationType" TEXT,
    "separationDate" TIMESTAMP(3),
    "noticePeriodDays" INTEGER NOT NULL DEFAULT 30,
    "rehireEligible" BOOLEAN,
    "rehireIneligibleReason" TEXT,
    "panNumber" TEXT,
    "aadhaarReference" TEXT,
    "uanNumber" TEXT,
    "deletedAt" TIMESTAMP(3),
    "engagementType" TEXT NOT NULL DEFAULT 'employee',
    "esicNumber" TEXT,
    "bankAccountNumber" TEXT,
    "bankIfsc" TEXT,
    "bankAccountName" TEXT,
    "taxRegime" TEXT NOT NULL DEFAULT 'new',
    "nomineeName" TEXT,
    "nomineeRelationship" TEXT,
    "emergencyContactName" TEXT,
    "emergencyContactPhone" TEXT,
    "backgroundVerificationConsentAt" TIMESTAMP(3),
    "codeOfConductAcknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "migratedToTenantId" TEXT,
    "spinOutBatchId" TEXT,

    CONSTRAINT "employment_relationships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requisitions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "budgetLineId" TEXT,
    "raisedByPartyId" TEXT,
    "targetStartDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "requisitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applications" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "requisitionId" TEXT NOT NULL,
    "candidatePartyId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Applied',
    "rejectionReason" TEXT,
    "screeningOutcome" TEXT,
    "assessmentState" TEXT,
    "holdFlag" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "managerPositionId" TEXT,
    "reasonCode" TEXT NOT NULL,
    "requestStatus" TEXT NOT NULL DEFAULT 'Draft',
    "rowStatus" TEXT NOT NULL DEFAULT 'Effective',
    "correlationId" TEXT,
    "decisionId" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compensation_records" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "linkedAssignmentId" TEXT,
    "revisionReason" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "basicPay" DECIMAL(14,2),
    "status" TEXT NOT NULL DEFAULT 'Proposed',
    "correlationId" TEXT,
    "decisionId" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compensation_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_types" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "employmentStateAffecting" BOOLEAN NOT NULL DEFAULT false,
    "statutory" BOOLEAN NOT NULL DEFAULT false,
    "annualEntitlementDays" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "carryForwardCapDays" DECIMAL(6,2),
    "encashable" BOOLEAN NOT NULL DEFAULT false,
    "maxEncashDays" DECIMAL(6,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leave_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_balances" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "balanceDays" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "heldDays" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leave_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_transactions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "leaveBalanceId" TEXT NOT NULL,
    "leaveRequestId" TEXT,
    "txnType" TEXT NOT NULL,
    "amountDays" DECIMAL(6,2) NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "days" DECIMAL(6,2) NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_attendances" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "workDate" TIMESTAMP(3) NOT NULL,
    "workedMinutes" INTEGER NOT NULL DEFAULT 0,
    "overtimeMinutes" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'Recorded',
    "missingPunch" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_attendances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goals" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "keyResultRef" TEXT,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "periodLabel" TEXT,
    "dueAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "goals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "performance_evidence" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "recordedByPartyId" TEXT,
    "caseScoped" BOOLEAN NOT NULL DEFAULT false,
    "caseRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "performance_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learning_activities" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "isCompliance" BOOLEAN NOT NULL DEFAULT false,
    "cost" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "courseId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "learning_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learning_records" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "learningActivityId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Enrolled',
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "learning_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skills" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "halfLifeMonths" INTEGER NOT NULL DEFAULT 24,
    "proficiencyScale" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capability_evidence" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "capabilityClaimId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "sourceRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "capability_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "capabilityClaimId" TEXT NOT NULL,
    "verifierPartyId" TEXT NOT NULL,
    "secondVerifierPartyId" TEXT,
    "note" TEXT,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_instructions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "payrollRunId" TEXT,
    "payPeriod" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "grossAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "deductions" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "netAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "division" TEXT,
    "paymentId" TEXT,
    "basicPay" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "hra" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "otherAllowances" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "pfEmployee" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "pfEmployer" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "epsEmployer" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "esiEmployee" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "esiEmployer" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "professionalTax" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "tdsAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "lwfEmployee" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "lwfEmployer" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "computedFrom" JSONB,
    "payslipNumber" TEXT,
    "payslipIssuedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_instructions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_runs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "payPeriod" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "grossTotal" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "netTotal" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "headcount" INTEGER NOT NULL DEFAULT 0,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "disbursedAt" TIMESTAMP(3),
    "preparedById" TEXT,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboardings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Initiated',
    "checklist" JSONB NOT NULL DEFAULT '[]',
    "blockedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "onboardings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offboardings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employmentRelationshipId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Initiated',
    "checklist" JSONB NOT NULL DEFAULT '[]',
    "disputeReason" TEXT,
    "settlementAmount" DECIMAL(14,2),
    "gratuityAmount" DECIMAL(14,2),
    "leaveEncashmentAmount" DECIMAL(14,2),
    "bonusAmount" DECIMAL(14,2),
    "noticeRecoveryAmount" DECIMAL(14,2),
    "settlementComputedAt" TIMESTAMP(3),
    "relievingLetterDocumentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "offboardings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_accounts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accountType" TEXT NOT NULL DEFAULT 'bank',
    "displayReference" TEXT,
    "openingBalance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "openingDate" TIMESTAMP(3),
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "ledgerGroup" TEXT NOT NULL DEFAULT 'asset',
    "accountClass" "LedgerAccountType" NOT NULL DEFAULT 'asset',
    "normalBalance" TEXT NOT NULL DEFAULT 'debit',
    "isPostable" BOOLEAN NOT NULL DEFAULT true,
    "parentId" TEXT,
    "requiresParty" BOOLEAN NOT NULL DEFAULT false,
    "requiresCostCentre" BOOLEAN NOT NULL DEFAULT false,
    "openingNote" TEXT,
    "spinOutBatchId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_categories" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'expense',
    "behaviour" TEXT NOT NULL DEFAULT 'variable',
    "parentId" TEXT,
    "defaultDivision" TEXT,
    "mustPay" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "spinOutBatchId" TEXT,

    CONSTRAINT "ledger_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "txnDate" TIMESTAMP(3) NOT NULL,
    "direction" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "accountId" TEXT NOT NULL,
    "categoryId" TEXT,
    "division" TEXT,
    "counterparty" TEXT,
    "method" TEXT NOT NULL DEFAULT 'bank_transfer',
    "reference" TEXT,
    "note" TEXT,
    "intercompanyTenantId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "payrollRunId" TEXT,
    "invoiceId" TEXT,
    "vendorBillId" TEXT,
    "fixedAssetId" TEXT,
    "loanId" TEXT,
    "reversalOfId" TEXT,
    "reversedById" TEXT,
    "reconciledAt" TIMESTAMP(3),
    "migratedToTenantId" TEXT,
    "spinOutBatchId" TEXT,
    "createdById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_bills" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "vendorName" TEXT NOT NULL,
    "vendorGstin" TEXT,
    "billNumber" TEXT,
    "billDate" TIMESTAMP(3) NOT NULL,
    "dueDate" TIMESTAMP(3),
    "categoryId" TEXT,
    "division" TEXT,
    "subtotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "paidAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" TEXT NOT NULL DEFAULT 'open',
    "note" TEXT,
    "overdueNotifiedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "vendorPan" TEXT,
    "rcmApplicable" BOOLEAN NOT NULL DEFAULT false,
    "rcmTaxAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "tdsSection" TEXT,
    "tdsRate" DECIMAL(5,2),
    "tdsAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "tdsCertificateRef" TEXT,
    "tdsChallanId" TEXT,
    "vendorUdyamNumber" TEXT,
    "agreedTermDays" INTEGER,
    "msmeDueAt" TIMESTAMP(3),
    "msmeNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_lines" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "division" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "budget_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recurring_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "division" TEXT,
    "direction" TEXT NOT NULL DEFAULT 'out',
    "amount" DECIMAL(18,2) NOT NULL,
    "cadence" TEXT NOT NULL DEFAULT 'monthly',
    "dayOfMonth" INTEGER NOT NULL DEFAULT 1,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastGeneratedPeriod" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recurring_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fixed_assets" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "purchaseDate" TIMESTAMP(3) NOT NULL,
    "cost" DECIMAL(18,2) NOT NULL,
    "salvageValue" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "usefulLifeMonths" INTEGER NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'straight_line',
    "wdvRate" DECIMAL(6,4) NOT NULL DEFAULT 0,
    "division" TEXT,
    "categoryId" TEXT,
    "disposedAt" TIMESTAMP(3),
    "disposalValue" DECIMAL(18,2),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fixed_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loans" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "lender" TEXT NOT NULL,
    "principal" DECIMAL(18,2) NOT NULL,
    "annualRate" DECIMAL(6,3) NOT NULL,
    "tenureMonths" INTEGER NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "accountId" TEXT,
    "division" TEXT,
    "closedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_batches" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceFormat" TEXT NOT NULL,
    "detectedAs" TEXT,
    "sourceLabel" TEXT,
    "status" TEXT NOT NULL DEFAULT 'parsed',
    "mapping" JSONB NOT NULL DEFAULT '{}',
    "stats" JSONB NOT NULL DEFAULT '{}',
    "options" JSONB NOT NULL DEFAULT '{}',
    "errorMessage" TEXT,
    "createdById" TEXT,
    "committedAt" TIMESTAMP(3),
    "revertedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_rows" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "normalised" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "message" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_members" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "din" TEXT,
    "appointedOn" TIMESTAMP(3) NOT NULL,
    "ceasedOn" TIMESTAMP(3),
    "interestsDeclaredOn" TIMESTAMP(3),
    "interests" JSONB NOT NULL DEFAULT '[]',
    "nominatedByHolderRef" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "board_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_meetings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "noticeSentOn" TIMESTAMP(3),
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "heldOn" TIMESTAMP(3),
    "mode" TEXT NOT NULL,
    "venue" TEXT,
    "quorumRequired" INTEGER NOT NULL,
    "attendees" JSONB NOT NULL DEFAULT '[]',
    "quorumMet" BOOLEAN,
    "agenda" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'called',
    "minutesDraftedOn" TIMESTAMP(3),
    "minutesCirculatedOn" TIMESTAMP(3),
    "minutesEnteredOn" TIMESTAMP(3),
    "minutesSignedOn" TIMESTAMP(3),
    "minutesText" TEXT,
    "minutesDocumentRef" TEXT,
    "chairedByBoardMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "board_meetings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resolutions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "passedBy" TEXT NOT NULL,
    "meetingId" TEXT,
    "requiresMeeting" BOOLEAN NOT NULL,
    "circulatedOn" TIMESTAMP(3),
    "dispatchProofRef" TEXT,
    "votingClosesOn" TIMESTAMP(3),
    "outcome" TEXT NOT NULL DEFAULT 'draft',
    "passedOn" TIMESTAMP(3),
    "mgt14Srn" TEXT,
    "mgt14FiledOn" TIMESTAMP(3),
    "signedDocumentRef" TEXT,
    "subjectRef" TEXT,
    "proposedByPartyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resolutions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "votes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "resolutionId" TEXT NOT NULL,
    "boardMemberId" TEXT,
    "holderRef" TEXT,
    "choice" TEXT NOT NULL,
    "castAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "abstainedAsInterested" BOOLEAN NOT NULL DEFAULT false,
    "demandsMeeting" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "votes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_items" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "basis" TEXT NOT NULL,
    "dueOn" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolvedOn" TIMESTAMP(3),
    "filedRef" TEXT,
    "relatedType" TEXT NOT NULL,
    "relatedId" TEXT NOT NULL,
    "raisedByJob" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compliance_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_pack_items" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "fileRef" TEXT NOT NULL,
    "addedByPartyId" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "board_pack_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_campaigns" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "channelMix" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "division" TEXT NOT NULL,
    "vertical" TEXT,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "budgetPlanned" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "budgetCommitted" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "budgetActual" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "ownerPartyId" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvalRequired" BOOLEAN NOT NULL DEFAULT false,
    "utmCampaign" TEXT NOT NULL,
    "targetLeads" INTEGER,
    "targetEnrolments" INTEGER,
    "targetPipelineValue" DECIMAL(18,2),
    "offeringId" TEXT,
    "courseId" TEXT,
    "audienceId" TEXT,
    "contentBrief" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_campaign_approvals" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "decidedById" TEXT,
    "decision" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "thresholdAmount" DECIMAL(18,2),
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_campaign_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_channels" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "providerAdapter" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "dltEntityId" TEXT,
    "senderIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_audiences" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'dynamic',
    "entityType" TEXT NOT NULL,
    "rules" JSONB NOT NULL DEFAULT '{}',
    "memberCount" INTEGER,
    "lastEvaluatedAt" TIMESTAMP(3),
    "description" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_audiences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_audience_members" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "audienceId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL DEFAULT 'rule',
    "suppressed" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_audience_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_preferences" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "channelKey" TEXT NOT NULL,
    "optedIn" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "doNotContact" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_templates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "channelKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "mergeFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'draft',
    "dltTemplateId" TEXT,
    "waTemplateName" TEXT,
    "approvedById" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "language" TEXT NOT NULL DEFAULT 'en',
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_sends" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "campaignId" TEXT,
    "templateId" TEXT NOT NULL,
    "channelKey" TEXT NOT NULL,
    "audienceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "scheduledAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "deliveredCount" INTEGER NOT NULL DEFAULT 0,
    "openedCount" INTEGER NOT NULL DEFAULT 0,
    "clickedCount" INTEGER NOT NULL DEFAULT 0,
    "bouncedCount" INTEGER NOT NULL DEFAULT 0,
    "unsubscribedCount" INTEGER NOT NULL DEFAULT 0,
    "requestedById" TEXT,
    "approvedById" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_sends_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_send_recipients" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "sendId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "reason" TEXT,
    "providerMessageId" TEXT,
    "events" JSONB NOT NULL DEFAULT '[]',
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_send_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_journeys" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "triggerKind" TEXT NOT NULL,
    "steps" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_journeys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_journey_runs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "journeyId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "currentStep" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "nextAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exitedReason" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_journey_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_forms" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "fields" JSONB NOT NULL DEFAULT '[]',
    "vertical" TEXT,
    "defaultCampaignId" TEXT,
    "thankYouMessage" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "publicToken" TEXT NOT NULL,
    "submissionCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_forms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_form_submissions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "utm" JSONB NOT NULL DEFAULT '{}',
    "personId" TEXT,
    "leadId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'received',
    "ip" TEXT,
    "userAgent" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_form_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_touchpoints" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "personId" TEXT,
    "organizationId" TEXT,
    "leadId" TEXT,
    "campaignId" TEXT,
    "channelKey" TEXT NOT NULL,
    "touchKind" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "utm" JSONB NOT NULL DEFAULT '{}',
    "sourceRef" TEXT,
    "cost" DECIMAL(18,2),
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_touchpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_attributions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "leadId" TEXT,
    "opportunityId" TEXT,
    "enrollmentId" TEXT,
    "model" TEXT NOT NULL,
    "campaignId" TEXT,
    "channelKey" TEXT NOT NULL,
    "weight" DECIMAL(18,2) NOT NULL DEFAULT 1,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_attributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_lead_score_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "condition" JSONB NOT NULL DEFAULT '{}',
    "points" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_lead_score_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "campaignId" TEXT,
    "institutionId" TEXT,
    "venue" TEXT,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3),
    "capacity" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "costPlanned" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "costActual" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "division" TEXT NOT NULL DEFAULT 'education',
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_event_registrations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'registered',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "leadId" TEXT,
    "checkedInAt" TIMESTAMP(3),
    "followUpDone" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_event_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_assets" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "url" TEXT,
    "storageRef" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "campaignId" TEXT,
    "usageRights" TEXT,
    "expiresAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_social_posts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "channelKey" TEXT NOT NULL,
    "campaignId" TEXT,
    "body" TEXT NOT NULL,
    "assetIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'draft',
    "externalUrl" TEXT,
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_social_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_short_links" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "campaignId" TEXT,
    "channelKey" TEXT,
    "utm" JSONB NOT NULL DEFAULT '{}',
    "clickCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_short_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_referral_programs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "rewardKind" TEXT NOT NULL DEFAULT 'none',
    "rewardAmount" DECIMAL(18,2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "terms" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_referral_programs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_referrals" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "referrerPersonId" TEXT,
    "referrerOrganizationId" TEXT,
    "code" TEXT NOT NULL,
    "referredPersonId" TEXT,
    "leadId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'issued',
    "rewardTransactionRef" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_referrals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_budgets" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "division" TEXT NOT NULL,
    "channelKey" TEXT,
    "campaignId" TEXT,
    "planned" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "committed" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_budgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_spends" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "campaignId" TEXT,
    "channelKey" TEXT NOT NULL,
    "division" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "spendDate" TIMESTAMP(3) NOT NULL,
    "vendorOrganizationId" TEXT,
    "description" TEXT,
    "transactionId" TEXT,
    "vendorBillId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'recorded',
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_spends_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_vendors" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "services" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "contractRef" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "rating" DECIMAL(3,2),
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_claims" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "evidenceRef" TEXT,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "approvedById" TEXT,
    "assetIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_plans" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "division" TEXT NOT NULL,
    "theme" TEXT,
    "goals" JSONB NOT NULL DEFAULT '{}',
    "campaignIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_webhooks_inbound" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventKind" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'received',
    "error" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_webhooks_inbound_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cmp_accounting_periods_tenantId_status_idx" ON "cmp_accounting_periods"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "cmp_accounting_periods_tenantId_period_key" ON "cmp_accounting_periods"("tenantId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "cmp_accounting_periods_tenantId_entityId_startsOn_key" ON "cmp_accounting_periods"("tenantId", "entityId", "startsOn");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entities_tenantId_code_key" ON "ledger_entities"("tenantId", "code");

-- CreateIndex
CREATE INDEX "journal_entries_tenantId_entityId_entryDate_idx" ON "journal_entries"("tenantId", "entityId", "entryDate");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_tenantId_entityId_entryNumber_key" ON "journal_entries"("tenantId", "entityId", "entryNumber");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_tenantId_idempotencyKey_key" ON "journal_entries"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "journal_lines_tenantId_accountId_entryId_idx" ON "journal_lines"("tenantId", "accountId", "entryId");

-- CreateIndex
CREATE INDEX "journal_lines_tenantId_partyId_idx" ON "journal_lines"("tenantId", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "cmp_retention_policies_tenantId_entityType_key" ON "cmp_retention_policies"("tenantId", "entityType");

-- CreateIndex
CREATE INDEX "cmp_retention_reviews_tenantId_status_idx" ON "cmp_retention_reviews"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "cmp_retention_reviews_tenantId_entityType_entityId_key" ON "cmp_retention_reviews"("tenantId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "cmp_schedule_iii_mappings_tenantId_statement_idx" ON "cmp_schedule_iii_mappings"("tenantId", "statement");

-- CreateIndex
CREATE UNIQUE INDEX "cmp_schedule_iii_mappings_tenantId_categoryId_accountId_key" ON "cmp_schedule_iii_mappings"("tenantId", "categoryId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "cmp_schedule_ii_useful_life_tenantId_assetClass_effectiveFr_key" ON "cmp_schedule_ii_useful_life"("tenantId", "assetClass", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "cmp_it_depreciation_blocks_tenantId_blockName_effectiveFrom_key" ON "cmp_it_depreciation_blocks"("tenantId", "blockName", "effectiveFrom");

-- CreateIndex
CREATE INDEX "cmp_bank_statement_lines_tenantId_accountId_date_idx" ON "cmp_bank_statement_lines"("tenantId", "accountId", "date");

-- CreateIndex
CREATE INDEX "cmp_bank_statement_lines_tenantId_matchedAt_idx" ON "cmp_bank_statement_lines"("tenantId", "matchedAt");

-- CreateIndex
CREATE INDEX "compliance_obligation_types_tenantId_domain_idx" ON "compliance_obligation_types"("tenantId", "domain");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_obligation_types_tenantId_code_key" ON "compliance_obligation_types"("tenantId", "code");

-- CreateIndex
CREATE INDEX "compliance_obligations_tenantId_status_idx" ON "compliance_obligations"("tenantId", "status");

-- CreateIndex
CREATE INDEX "compliance_obligations_tenantId_dueAt_idx" ON "compliance_obligations"("tenantId", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_obligations_tenantId_typeId_period_key" ON "compliance_obligations"("tenantId", "typeId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "security_policies_tenantId_key" ON "security_policies"("tenantId");

-- CreateIndex
CREATE INDEX "compliance_backup_runs_tenantId_startedAt_idx" ON "compliance_backup_runs"("tenantId", "startedAt");

-- CreateIndex
CREATE INDEX "compliance_register_entries_tenantId_registerKind_subjectKe_idx" ON "compliance_register_entries"("tenantId", "registerKind", "subjectKey");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_register_entries_tenantId_recordCode_key" ON "compliance_register_entries"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "compliance_board_meetings_tenantId_heldOn_idx" ON "compliance_board_meetings"("tenantId", "heldOn");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_board_meetings_tenantId_recordCode_key" ON "compliance_board_meetings"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "compliance_board_resolutions_tenantId_meetingId_idx" ON "compliance_board_resolutions"("tenantId", "meetingId");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_board_resolutions_tenantId_recordCode_key" ON "compliance_board_resolutions"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "compliance_mca_filings_tenantId_form_fy_idx" ON "compliance_mca_filings"("tenantId", "form", "fy");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_mca_filings_tenantId_recordCode_key" ON "compliance_mca_filings"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "compliance_stamp_duty_rules_tenantId_agreementKind_effectiv_idx" ON "compliance_stamp_duty_rules"("tenantId", "agreementKind", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_esign_configs_tenantId_key" ON "compliance_esign_configs"("tenantId");

-- CreateIndex
CREATE INDEX "compliance_document_retention_rules_tenantId_documentKind_e_idx" ON "compliance_document_retention_rules"("tenantId", "documentKind", "effectiveFrom");

-- CreateIndex
CREATE INDEX "compliance_refund_policies_tenantId_effectiveFrom_idx" ON "compliance_refund_policies"("tenantId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_refund_policies_tenantId_version_key" ON "compliance_refund_policies"("tenantId", "version");

-- CreateIndex
CREATE INDEX "compliance_refunds_tenantId_status_idx" ON "compliance_refunds"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_refunds_tenantId_recordCode_key" ON "compliance_refunds"("tenantId", "recordCode");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_certificates_verificationCode_key" ON "compliance_certificates"("verificationCode");

-- CreateIndex
CREATE INDEX "compliance_certificates_tenantId_enrollmentId_idx" ON "compliance_certificates"("tenantId", "enrollmentId");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_certificates_tenantId_number_key" ON "compliance_certificates"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "course_gst_exemptions_tenantId_courseId_key" ON "course_gst_exemptions"("tenantId", "courseId");

-- CreateIndex
CREATE INDEX "rcm_self_invoices_tenantId_billId_idx" ON "rcm_self_invoices"("tenantId", "billId");

-- CreateIndex
CREATE INDEX "rcm_self_invoices_tenantId_period_idx" ON "rcm_self_invoices"("tenantId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "rcm_self_invoices_tenantId_number_key" ON "rcm_self_invoices"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "credit_note_reasons_creditNoteId_key" ON "credit_note_reasons"("creditNoteId");

-- CreateIndex
CREATE INDEX "debit_notes_tenantId_invoiceId_idx" ON "debit_notes"("tenantId", "invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "debit_notes_tenantId_recordCode_key" ON "debit_notes"("tenantId", "recordCode");

-- CreateIndex
CREATE UNIQUE INDEX "einvoice_configs_tenantId_key" ON "einvoice_configs"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "gstr2b_imports_tenantId_period_key" ON "gstr2b_imports"("tenantId", "period");

-- CreateIndex
CREATE INDEX "gstr2b_matches_tenantId_period_idx" ON "gstr2b_matches"("tenantId", "period");

-- CreateIndex
CREATE INDEX "gstr2b_matches_tenantId_vendorBillId_idx" ON "gstr2b_matches"("tenantId", "vendorBillId");

-- CreateIndex
CREATE INDEX "gst_rate_tables_tenantId_effectiveFrom_idx" ON "gst_rate_tables"("tenantId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "compliance_labour_holidays_tenantId_date_idx" ON "compliance_labour_holidays"("tenantId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_labour_holidays_tenantId_date_name_key" ON "compliance_labour_holidays"("tenantId", "date", "name");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_labour_leave_year_closes_tenantId_leaveTypeId_fy_key" ON "compliance_labour_leave_year_closes"("tenantId", "leaveTypeId", "fy");

-- CreateIndex
CREATE INDEX "compliance_labour_leave_encashments_tenantId_employmentRela_idx" ON "compliance_labour_leave_encashments"("tenantId", "employmentRelationshipId");

-- CreateIndex
CREATE INDEX "compliance_labour_working_hours_rules_tenantId_effectiveFro_idx" ON "compliance_labour_working_hours_rules"("tenantId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_labour_overtime_accruals_tenantId_employmentRela_key" ON "compliance_labour_overtime_accruals"("tenantId", "employmentRelationshipId", "isoWeek");

-- CreateIndex
CREATE INDEX "compliance_labour_icc_members_tenantId_role_idx" ON "compliance_labour_icc_members"("tenantId", "role");

-- CreateIndex
CREATE INDEX "compliance_labour_posh_complaints_tenantId_status_idx" ON "compliance_labour_posh_complaints"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_labour_posh_complaints_tenantId_number_key" ON "compliance_labour_posh_complaints"("tenantId", "number");

-- CreateIndex
CREATE INDEX "compliance_labour_posh_workshops_tenantId_heldOn_idx" ON "compliance_labour_posh_workshops"("tenantId", "heldOn");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_labour_posh_annual_reports_tenantId_year_key" ON "compliance_labour_posh_annual_reports"("tenantId", "year");

-- CreateIndex
CREATE INDEX "compliance_labour_disciplinary_cases_tenantId_employmentRel_idx" ON "compliance_labour_disciplinary_cases"("tenantId", "employmentRelationshipId");

-- CreateIndex
CREATE INDEX "compliance_labour_disciplinary_cases_tenantId_status_idx" ON "compliance_labour_disciplinary_cases"("tenantId", "status");

-- CreateIndex
CREATE INDEX "compliance_labour_hr_letters_tenantId_employmentRelationshi_idx" ON "compliance_labour_hr_letters"("tenantId", "employmentRelationshipId");

-- CreateIndex
CREATE INDEX "compliance_labour_hr_letters_tenantId_applicationId_idx" ON "compliance_labour_hr_letters"("tenantId", "applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_labour_hr_letters_tenantId_number_key" ON "compliance_labour_hr_letters"("tenantId", "number");

-- CreateIndex
CREATE INDEX "cmp_pay_pf_rate_tables_tenantId_effectiveFrom_idx" ON "cmp_pay_pf_rate_tables"("tenantId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "cmp_pay_esi_rate_tables_tenantId_effectiveFrom_idx" ON "cmp_pay_esi_rate_tables"("tenantId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "cmp_pay_pt_slab_tables_tenantId_state_effectiveFrom_idx" ON "cmp_pay_pt_slab_tables"("tenantId", "state", "effectiveFrom");

-- CreateIndex
CREATE INDEX "cmp_pay_lwf_rate_tables_tenantId_state_effectiveFrom_idx" ON "cmp_pay_lwf_rate_tables"("tenantId", "state", "effectiveFrom");

-- CreateIndex
CREATE INDEX "cmp_pay_minimum_wage_tables_tenantId_state_category_effecti_idx" ON "cmp_pay_minimum_wage_tables"("tenantId", "state", "category", "effectiveFrom");

-- CreateIndex
CREATE INDEX "cmp_pay_salary_structures_tenantId_employmentRelationshipId_idx" ON "cmp_pay_salary_structures"("tenantId", "employmentRelationshipId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "cmp_pay_salary_structures_tenantId_status_idx" ON "cmp_pay_salary_structures"("tenantId", "status");

-- CreateIndex
CREATE INDEX "cmp_pay_payslips_tenantId_employmentRelationshipId_payPerio_idx" ON "cmp_pay_payslips"("tenantId", "employmentRelationshipId", "payPeriod");

-- CreateIndex
CREATE INDEX "cmp_pay_payslips_tenantId_instructionId_idx" ON "cmp_pay_payslips"("tenantId", "instructionId");

-- CreateIndex
CREATE UNIQUE INDEX "cmp_pay_payslips_tenantId_number_key" ON "cmp_pay_payslips"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "cmp_pay_gratuity_accruals_tenantId_employmentRelationshipId_key" ON "cmp_pay_gratuity_accruals"("tenantId", "employmentRelationshipId", "asOfDate");

-- CreateIndex
CREATE INDEX "privacy_notices_tenantId_status_idx" ON "privacy_notices"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "privacy_notices_tenantId_version_key" ON "privacy_notices"("tenantId", "version");

-- CreateIndex
CREATE INDEX "notice_acknowledgements_tenantId_personId_idx" ON "notice_acknowledgements"("tenantId", "personId");

-- CreateIndex
CREATE INDEX "notice_acknowledgements_tenantId_noticeVersion_idx" ON "notice_acknowledgements"("tenantId", "noticeVersion");

-- CreateIndex
CREATE INDEX "consents_tenantId_personId_status_idx" ON "consents"("tenantId", "personId", "status");

-- CreateIndex
CREATE INDEX "consents_tenantId_purposeCode_status_idx" ON "consents"("tenantId", "purposeCode", "status");

-- CreateIndex
CREATE INDEX "consents_tenantId_guardianOfPersonId_idx" ON "consents"("tenantId", "guardianOfPersonId");

-- CreateIndex
CREATE INDEX "consent_ledger_tenantId_dataPrincipalId_purpose_createdAt_idx" ON "consent_ledger"("tenantId", "dataPrincipalId", "purpose", "createdAt");

-- CreateIndex
CREATE INDEX "consent_ledger_tenantId_consentId_createdAt_idx" ON "consent_ledger"("tenantId", "consentId", "createdAt");

-- CreateIndex
CREATE INDEX "data_principal_requests_tenantId_status_idx" ON "data_principal_requests"("tenantId", "status");

-- CreateIndex
CREATE INDEX "data_principal_requests_tenantId_personId_idx" ON "data_principal_requests"("tenantId", "personId");

-- CreateIndex
CREATE INDEX "data_principal_requests_tenantId_dueAt_idx" ON "data_principal_requests"("tenantId", "dueAt");

-- CreateIndex
CREATE INDEX "data_breaches_tenantId_status_idx" ON "data_breaches"("tenantId", "status");

-- CreateIndex
CREATE INDEX "retention_schedules_tenantId_retentionClass_idx" ON "retention_schedules"("tenantId", "retentionClass");

-- CreateIndex
CREATE UNIQUE INDEX "retention_schedules_tenantId_retentionClass_effectiveFrom_key" ON "retention_schedules"("tenantId", "retentionClass", "effectiveFrom");

-- CreateIndex
CREATE INDEX "retention_reports_tenantId_generatedAt_idx" ON "retention_reports"("tenantId", "generatedAt");

-- CreateIndex
CREATE INDEX "access_reviews_tenantId_generatedAt_idx" ON "access_reviews"("tenantId", "generatedAt");

-- CreateIndex
CREATE INDEX "encryption_backfill_runs_tenantId_ranAt_idx" ON "encryption_backfill_runs"("tenantId", "ranAt");

-- CreateIndex
CREATE INDEX "statutory_rules_tenantId_domain_key_jurisdiction_effectiveF_idx" ON "statutory_rules"("tenantId", "domain", "key", "jurisdiction", "effectiveFrom");

-- CreateIndex
CREATE INDEX "einvoice_submissions_tenantId_invoiceId_idx" ON "einvoice_submissions"("tenantId", "invoiceId");

-- CreateIndex
CREATE INDEX "einvoice_submissions_tenantId_status_idx" ON "einvoice_submissions"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "einvoice_submissions_tenantId_idempotencyKey_key" ON "einvoice_submissions"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "payroll_statutory_lines_tenantId_payrollRunId_idx" ON "payroll_statutory_lines"("tenantId", "payrollRunId");

-- CreateIndex
CREATE INDEX "payroll_statutory_lines_tenantId_employmentRelationshipId_p_idx" ON "payroll_statutory_lines"("tenantId", "employmentRelationshipId", "payPeriod");

-- CreateIndex
CREATE INDEX "tds_section_rates_tenantId_section_idx" ON "tds_section_rates"("tenantId", "section");

-- CreateIndex
CREATE UNIQUE INDEX "tds_section_rates_tenantId_section_effectiveFrom_key" ON "tds_section_rates"("tenantId", "section", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "tds_applicability_rules_tenantId_categoryId_key" ON "tds_applicability_rules"("tenantId", "categoryId");

-- CreateIndex
CREATE INDEX "tds_decisions_tenantId_billId_idx" ON "tds_decisions"("tenantId", "billId");

-- CreateIndex
CREATE INDEX "tds_challans_tenantId_month_sectionGroup_idx" ON "tds_challans"("tenantId", "month", "sectionGroup");

-- CreateIndex
CREATE UNIQUE INDEX "tds_challans_tenantId_recordCode_key" ON "tds_challans"("tenantId", "recordCode");

-- CreateIndex
CREATE UNIQUE INDEX "tax_declarations_tenantId_employmentRelationshipId_fy_key" ON "tax_declarations"("tenantId", "employmentRelationshipId", "fy");

-- CreateIndex
CREATE UNIQUE INDEX "income_tax_slab_tables_tenantId_fy_regime_key" ON "income_tax_slab_tables"("tenantId", "fy", "regime");

-- CreateIndex
CREATE UNIQUE INDEX "corporate_tax_rates_tenantId_regime_effectiveFrom_key" ON "corporate_tax_rates"("tenantId", "regime", "effectiveFrom");

-- CreateIndex
CREATE INDEX "advance_tax_payments_tenantId_fy_idx" ON "advance_tax_payments"("tenantId", "fy");

-- CreateIndex
CREATE INDEX "tds_returns_tenantId_fy_quarter_form_idx" ON "tds_returns"("tenantId", "fy", "quarter", "form");

-- CreateIndex
CREATE INDEX "tds_certificates_tenantId_form_deducteeRef_fy_idx" ON "tds_certificates"("tenantId", "form", "deducteeRef", "fy");

-- CreateIndex
CREATE UNIQUE INDEX "tds_certificates_tenantId_number_key" ON "tds_certificates"("tenantId", "number");

-- CreateIndex
CREATE INDEX "hcm_assets_assets_tenantId_status_idx" ON "hcm_assets_assets"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_assets_assets_tenantId_tag_key" ON "hcm_assets_assets"("tenantId", "tag");

-- CreateIndex
CREATE INDEX "hcm_assets_asset_assignments_tenantId_assetId_idx" ON "hcm_assets_asset_assignments"("tenantId", "assetId");

-- CreateIndex
CREATE INDEX "hcm_assets_asset_assignments_tenantId_employmentRelationshi_idx" ON "hcm_assets_asset_assignments"("tenantId", "employmentRelationshipId");

-- CreateIndex
CREATE INDEX "hcm_assets_travel_requests_tenantId_employmentRelationshipI_idx" ON "hcm_assets_travel_requests"("tenantId", "employmentRelationshipId");

-- CreateIndex
CREATE INDEX "hcm_assets_travel_requests_tenantId_status_idx" ON "hcm_assets_travel_requests"("tenantId", "status");

-- CreateIndex
CREATE INDEX "hcm_assets_letter_requests_tenantId_employmentRelationshipI_idx" ON "hcm_assets_letter_requests"("tenantId", "employmentRelationshipId");

-- CreateIndex
CREATE INDEX "hcm_assets_letter_requests_tenantId_status_idx" ON "hcm_assets_letter_requests"("tenantId", "status");

-- CreateIndex
CREATE INDEX "hcm_assets_id_cards_tenantId_employmentRelationshipId_idx" ON "hcm_assets_id_cards"("tenantId", "employmentRelationshipId");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_assets_id_cards_tenantId_cardNumber_key" ON "hcm_assets_id_cards"("tenantId", "cardNumber");

-- CreateIndex
CREATE INDEX "hcm_compensation_pay_grades_tenantId_idx" ON "hcm_compensation_pay_grades"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_compensation_pay_grades_tenantId_code_key" ON "hcm_compensation_pay_grades"("tenantId", "code");

-- CreateIndex
CREATE INDEX "hcm_compensation_revision_cycles_tenantId_idx" ON "hcm_compensation_revision_cycles"("tenantId");

-- CreateIndex
CREATE INDEX "hcm_compensation_revision_lines_tenantId_cycleId_idx" ON "hcm_compensation_revision_lines"("tenantId", "cycleId");

-- CreateIndex
CREATE INDEX "hcm_compensation_revision_lines_tenantId_employmentRelation_idx" ON "hcm_compensation_revision_lines"("tenantId", "employmentRelationshipId");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_compensation_revision_lines_tenantId_cycleId_employment_key" ON "hcm_compensation_revision_lines"("tenantId", "cycleId", "employmentRelationshipId");

-- CreateIndex
CREATE INDEX "hcm_compensation_variable_pay_plans_tenantId_idx" ON "hcm_compensation_variable_pay_plans"("tenantId");

-- CreateIndex
CREATE INDEX "hcm_compensation_variable_payouts_tenantId_employmentRelati_idx" ON "hcm_compensation_variable_payouts"("tenantId", "employmentRelationshipId");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_compensation_variable_payouts_tenantId_planId_employmen_key" ON "hcm_compensation_variable_payouts"("tenantId", "planId", "employmentRelationshipId", "period");

-- CreateIndex
CREATE INDEX "hcm_compensation_benefit_plans_tenantId_idx" ON "hcm_compensation_benefit_plans"("tenantId");

-- CreateIndex
CREATE INDEX "hcm_compensation_benefit_enrollments_tenantId_employmentRel_idx" ON "hcm_compensation_benefit_enrollments"("tenantId", "employmentRelationshipId");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_compensation_benefit_enrollments_tenantId_planId_employ_key" ON "hcm_compensation_benefit_enrollments"("tenantId", "planId", "employmentRelationshipId");

-- CreateIndex
CREATE INDEX "hcm_compensation_employee_loans_tenantId_employmentRelation_idx" ON "hcm_compensation_employee_loans"("tenantId", "employmentRelationshipId");

-- CreateIndex
CREATE INDEX "hcm_compensation_expense_claims_tenantId_employmentRelation_idx" ON "hcm_compensation_expense_claims"("tenantId", "employmentRelationshipId");

-- CreateIndex
CREATE INDEX "hcm_engagement_announcements_tenantId_status_publishAt_idx" ON "hcm_engagement_announcements"("tenantId", "status", "publishAt");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_engagement_announcement_acks_tenantId_announcementId_pa_key" ON "hcm_engagement_announcement_acks"("tenantId", "announcementId", "partyId");

-- CreateIndex
CREATE INDEX "hcm_engagement_recognitions_tenantId_toPartyId_idx" ON "hcm_engagement_recognitions"("tenantId", "toPartyId");

-- CreateIndex
CREATE INDEX "hcm_engagement_recognitions_tenantId_fromPartyId_idx" ON "hcm_engagement_recognitions"("tenantId", "fromPartyId");

-- CreateIndex
CREATE INDEX "hcm_engagement_pulse_surveys_tenantId_status_idx" ON "hcm_engagement_pulse_surveys"("tenantId", "status");

-- CreateIndex
CREATE INDEX "hcm_engagement_survey_responses_tenantId_surveyId_idx" ON "hcm_engagement_survey_responses"("tenantId", "surveyId");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_engagement_survey_responses_tenantId_surveyId_employmen_key" ON "hcm_engagement_survey_responses"("tenantId", "surveyId", "employmentRelationshipId");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_engagement_survey_response_dedupes_tenantId_surveyId_de_key" ON "hcm_engagement_survey_response_dedupes"("tenantId", "surveyId", "dedupeHash");

-- CreateIndex
CREATE INDEX "hcm_engagement_hr_cases_tenantId_status_confidential_idx" ON "hcm_engagement_hr_cases"("tenantId", "status", "confidential");

-- CreateIndex
CREATE INDEX "hcm_engagement_hr_cases_tenantId_raisedByPartyId_idx" ON "hcm_engagement_hr_cases"("tenantId", "raisedByPartyId");

-- CreateIndex
CREATE INDEX "hcm_engagement_hr_case_messages_tenantId_caseId_idx" ON "hcm_engagement_hr_case_messages"("tenantId", "caseId");

-- CreateIndex
CREATE INDEX "hcm_engagement_policy_documents_tenantId_status_idx" ON "hcm_engagement_policy_documents"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_engagement_policy_acknowledgements_tenantId_policyDocum_key" ON "hcm_engagement_policy_acknowledgements"("tenantId", "policyDocumentId", "partyId");

-- CreateIndex
CREATE INDEX "hcm_engagement_exit_interviews_tenantId_employmentRelations_idx" ON "hcm_engagement_exit_interviews"("tenantId", "employmentRelationshipId");

-- CreateIndex
CREATE INDEX "hcm_learning_training_programs_tenantId_isActive_idx" ON "hcm_learning_training_programs"("tenantId", "isActive");

-- CreateIndex
CREATE INDEX "hcm_learning_training_sessions_tenantId_programId_idx" ON "hcm_learning_training_sessions"("tenantId", "programId");

-- CreateIndex
CREATE INDEX "hcm_learning_training_sessions_tenantId_startsAt_idx" ON "hcm_learning_training_sessions"("tenantId", "startsAt");

-- CreateIndex
CREATE INDEX "hcm_learning_training_enrollments_tenantId_employmentRelati_idx" ON "hcm_learning_training_enrollments"("tenantId", "employmentRelationshipId");

-- CreateIndex
CREATE INDEX "hcm_learning_training_enrollments_tenantId_status_idx" ON "hcm_learning_training_enrollments"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_learning_training_enrollments_tenantId_sessionId_employ_key" ON "hcm_learning_training_enrollments"("tenantId", "sessionId", "employmentRelationshipId");

-- CreateIndex
CREATE INDEX "hcm_learning_certifications_tenantId_employmentRelationship_idx" ON "hcm_learning_certifications"("tenantId", "employmentRelationshipId");

-- CreateIndex
CREATE INDEX "hcm_learning_certifications_tenantId_expiresOn_idx" ON "hcm_learning_certifications"("tenantId", "expiresOn");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_learning_certifications_tenantId_recordCode_key" ON "hcm_learning_certifications"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "hcm_learning_mandatory_training_rules_tenantId_isActive_idx" ON "hcm_learning_mandatory_training_rules"("tenantId", "isActive");

-- CreateIndex
CREATE INDEX "hcm_learning_idps_tenantId_employmentRelationshipId_idx" ON "hcm_learning_idps"("tenantId", "employmentRelationshipId");

-- CreateIndex
CREATE INDEX "hcm_learning_training_budgets_tenantId_fy_idx" ON "hcm_learning_training_budgets"("tenantId", "fy");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_learning_training_budgets_tenantId_fy_division_key" ON "hcm_learning_training_budgets"("tenantId", "fy", "division");

-- CreateIndex
CREATE INDEX "hcm_leavepolicy_policies_tenantId_status_idx" ON "hcm_leavepolicy_policies"("tenantId", "status");

-- CreateIndex
CREATE INDEX "hcm_leavepolicy_policies_tenantId_effectiveFrom_idx" ON "hcm_leavepolicy_policies"("tenantId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "hcm_leavepolicy_rules_tenantId_leaveTypeId_idx" ON "hcm_leavepolicy_rules"("tenantId", "leaveTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_leavepolicy_rules_leavePolicyId_leaveTypeId_key" ON "hcm_leavepolicy_rules"("leavePolicyId", "leaveTypeId");

-- CreateIndex
CREATE INDEX "hcm_leavepolicy_accrual_runs_tenantId_period_idx" ON "hcm_leavepolicy_accrual_runs"("tenantId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_leavepolicy_accrual_runs_tenantId_leavePolicyRuleId_per_key" ON "hcm_leavepolicy_accrual_runs"("tenantId", "leavePolicyRuleId", "period");

-- CreateIndex
CREATE INDEX "hcm_leavepolicy_approval_chains_tenantId_idx" ON "hcm_leavepolicy_approval_chains"("tenantId");

-- CreateIndex
CREATE INDEX "hcm_leavepolicy_request_approvals_tenantId_leaveRequestId_idx" ON "hcm_leavepolicy_request_approvals"("tenantId", "leaveRequestId");

-- CreateIndex
CREATE INDEX "hcm_leavepolicy_request_approvals_tenantId_approverPartyId__idx" ON "hcm_leavepolicy_request_approvals"("tenantId", "approverPartyId", "decision");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_leavepolicy_request_approvals_tenantId_leaveRequestId_l_key" ON "hcm_leavepolicy_request_approvals"("tenantId", "leaveRequestId", "level");

-- CreateIndex
CREATE INDEX "hcm_leavepolicy_restricted_holiday_elections_tenantId_emplo_idx" ON "hcm_leavepolicy_restricted_holiday_elections"("tenantId", "employmentRelationshipId", "fy");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_leavepolicy_restricted_holiday_elections_tenantId_emplo_key" ON "hcm_leavepolicy_restricted_holiday_elections"("tenantId", "employmentRelationshipId", "holidayId");

-- CreateIndex
CREATE INDEX "hcm_pay_items_tenantId_idx" ON "hcm_pay_items"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_pay_items_tenantId_code_key" ON "hcm_pay_items"("tenantId", "code");

-- CreateIndex
CREATE INDEX "hcm_adhoc_pay_lines_tenantId_employmentRelationshipId_idx" ON "hcm_adhoc_pay_lines"("tenantId", "employmentRelationshipId");

-- CreateIndex
CREATE INDEX "hcm_adhoc_pay_lines_tenantId_payPeriod_idx" ON "hcm_adhoc_pay_lines"("tenantId", "payPeriod");

-- CreateIndex
CREATE INDEX "hcm_adhoc_pay_lines_tenantId_status_idx" ON "hcm_adhoc_pay_lines"("tenantId", "status");

-- CreateIndex
CREATE INDEX "hcm_arrears_tenantId_employmentRelationshipId_idx" ON "hcm_arrears"("tenantId", "employmentRelationshipId");

-- CreateIndex
CREATE INDEX "hcm_arrears_tenantId_status_idx" ON "hcm_arrears"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_payroll_journals_payrollRunId_key" ON "hcm_payroll_journals"("payrollRunId");

-- CreateIndex
CREATE INDEX "hcm_payroll_journals_tenantId_payPeriod_idx" ON "hcm_payroll_journals"("tenantId", "payPeriod");

-- CreateIndex
CREATE INDEX "hcm_bank_advices_tenantId_payrollRunId_idx" ON "hcm_bank_advices"("tenantId", "payrollRunId");

-- CreateIndex
CREATE INDEX "hcm_payroll_reconciliations_tenantId_payrollRunId_idx" ON "hcm_payroll_reconciliations"("tenantId", "payrollRunId");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_payroll_calendar_tenantId_payPeriod_key" ON "hcm_payroll_calendar"("tenantId", "payPeriod");

-- CreateIndex
CREATE INDEX "hcm_payroll_queries_tenantId_employmentRelationshipId_idx" ON "hcm_payroll_queries"("tenantId", "employmentRelationshipId");

-- CreateIndex
CREATE INDEX "hcm_payroll_queries_tenantId_status_idx" ON "hcm_payroll_queries"("tenantId", "status");

-- CreateIndex
CREATE INDEX "hcm_performance_review_cycles_tenantId_idx" ON "hcm_performance_review_cycles"("tenantId");

-- CreateIndex
CREATE INDEX "hcm_performance_review_cycles_tenantId_phase_idx" ON "hcm_performance_review_cycles"("tenantId", "phase");

-- CreateIndex
CREATE INDEX "hcm_performance_review_templates_tenantId_idx" ON "hcm_performance_review_templates"("tenantId");

-- CreateIndex
CREATE INDEX "hcm_performance_review_assignments_tenantId_cycleId_idx" ON "hcm_performance_review_assignments"("tenantId", "cycleId");

-- CreateIndex
CREATE INDEX "hcm_performance_review_assignments_tenantId_employmentRelat_idx" ON "hcm_performance_review_assignments"("tenantId", "employmentRelationshipId");

-- CreateIndex
CREATE INDEX "hcm_performance_review_assignments_tenantId_reviewerPartyId_idx" ON "hcm_performance_review_assignments"("tenantId", "reviewerPartyId");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_performance_review_responses_assignmentId_key" ON "hcm_performance_review_responses"("assignmentId");

-- CreateIndex
CREATE INDEX "hcm_performance_review_responses_tenantId_assignmentId_idx" ON "hcm_performance_review_responses"("tenantId", "assignmentId");

-- CreateIndex
CREATE INDEX "hcm_performance_calibration_sessions_tenantId_cycleId_idx" ON "hcm_performance_calibration_sessions"("tenantId", "cycleId");

-- CreateIndex
CREATE INDEX "hcm_performance_final_ratings_tenantId_employmentRelationsh_idx" ON "hcm_performance_final_ratings"("tenantId", "employmentRelationshipId");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_performance_final_ratings_tenantId_cycleId_employmentRe_key" ON "hcm_performance_final_ratings"("tenantId", "cycleId", "employmentRelationshipId");

-- CreateIndex
CREATE INDEX "hcm_performance_feedback_tenantId_toEmploymentRelationshipI_idx" ON "hcm_performance_feedback"("tenantId", "toEmploymentRelationshipId");

-- CreateIndex
CREATE INDEX "hcm_performance_feedback_tenantId_fromPartyId_idx" ON "hcm_performance_feedback"("tenantId", "fromPartyId");

-- CreateIndex
CREATE INDEX "hcm_performance_one_on_ones_tenantId_reportEmploymentRelati_idx" ON "hcm_performance_one_on_ones"("tenantId", "reportEmploymentRelationshipId");

-- CreateIndex
CREATE INDEX "hcm_performance_one_on_ones_tenantId_managerPartyId_idx" ON "hcm_performance_one_on_ones"("tenantId", "managerPartyId");

-- CreateIndex
CREATE INDEX "hcm_performance_pips_tenantId_employmentRelationshipId_idx" ON "hcm_performance_pips"("tenantId", "employmentRelationshipId");

-- CreateIndex
CREATE INDEX "hcm_performance_succession_plans_tenantId_idx" ON "hcm_performance_succession_plans"("tenantId");

-- CreateIndex
CREATE INDEX "hcm_recruiting_job_postings_tenantId_status_idx" ON "hcm_recruiting_job_postings"("tenantId", "status");

-- CreateIndex
CREATE INDEX "hcm_recruiting_job_postings_tenantId_requisitionId_idx" ON "hcm_recruiting_job_postings"("tenantId", "requisitionId");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_recruiting_job_postings_tenantId_recordCode_key" ON "hcm_recruiting_job_postings"("tenantId", "recordCode");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_recruiting_job_postings_tenantId_slug_key" ON "hcm_recruiting_job_postings"("tenantId", "slug");

-- CreateIndex
CREATE INDEX "hcm_recruiting_candidate_profiles_tenantId_source_idx" ON "hcm_recruiting_candidate_profiles"("tenantId", "source");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_recruiting_candidate_profiles_tenantId_personId_key" ON "hcm_recruiting_candidate_profiles"("tenantId", "personId");

-- CreateIndex
CREATE INDEX "hcm_recruiting_interview_rounds_tenantId_applicationId_idx" ON "hcm_recruiting_interview_rounds"("tenantId", "applicationId");

-- CreateIndex
CREATE INDEX "hcm_recruiting_interview_rounds_tenantId_status_idx" ON "hcm_recruiting_interview_rounds"("tenantId", "status");

-- CreateIndex
CREATE INDEX "hcm_recruiting_interview_scorecards_tenantId_roundId_idx" ON "hcm_recruiting_interview_scorecards"("tenantId", "roundId");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_recruiting_interview_scorecards_tenantId_roundId_interv_key" ON "hcm_recruiting_interview_scorecards"("tenantId", "roundId", "interviewerPartyId");

-- CreateIndex
CREATE INDEX "hcm_recruiting_offer_letters_tenantId_applicationId_idx" ON "hcm_recruiting_offer_letters"("tenantId", "applicationId");

-- CreateIndex
CREATE INDEX "hcm_recruiting_offer_letters_tenantId_status_idx" ON "hcm_recruiting_offer_letters"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_recruiting_offer_letters_tenantId_recordCode_key" ON "hcm_recruiting_offer_letters"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "hcm_recruiting_referrals_tenantId_referrerEmploymentId_idx" ON "hcm_recruiting_referrals"("tenantId", "referrerEmploymentId");

-- CreateIndex
CREATE INDEX "hcm_recruiting_referrals_tenantId_status_idx" ON "hcm_recruiting_referrals"("tenantId", "status");

-- CreateIndex
CREATE INDEX "hcm_recruiting_background_verifications_tenantId_status_idx" ON "hcm_recruiting_background_verifications"("tenantId", "status");

-- CreateIndex
CREATE INDEX "hcm_recruiting_background_verifications_tenantId_applicatio_idx" ON "hcm_recruiting_background_verifications"("tenantId", "applicationId");

-- CreateIndex
CREATE INDEX "hcm_recruiting_onboarding_task_templates_tenantId_active_idx" ON "hcm_recruiting_onboarding_task_templates"("tenantId", "active");

-- CreateIndex
CREATE INDEX "hcm_recruiting_onboarding_tasks_tenantId_employmentId_idx" ON "hcm_recruiting_onboarding_tasks"("tenantId", "employmentId");

-- CreateIndex
CREATE INDEX "hcm_recruiting_onboarding_tasks_tenantId_status_idx" ON "hcm_recruiting_onboarding_tasks"("tenantId", "status");

-- CreateIndex
CREATE INDEX "hcm_sep_resignations_tenantId_employmentRelationshipId_idx" ON "hcm_sep_resignations"("tenantId", "employmentRelationshipId");

-- CreateIndex
CREATE INDEX "hcm_sep_resignations_tenantId_status_idx" ON "hcm_sep_resignations"("tenantId", "status");

-- CreateIndex
CREATE INDEX "hcm_sep_notice_policies_tenantId_active_idx" ON "hcm_sep_notice_policies"("tenantId", "active");

-- CreateIndex
CREATE INDEX "hcm_sep_exit_clearances_tenantId_offboardingId_idx" ON "hcm_sep_exit_clearances"("tenantId", "offboardingId");

-- CreateIndex
CREATE INDEX "hcm_sep_exit_clearances_tenantId_employmentRelationshipId_idx" ON "hcm_sep_exit_clearances"("tenantId", "employmentRelationshipId");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_sep_exit_clearances_tenantId_offboardingId_department_key" ON "hcm_sep_exit_clearances"("tenantId", "offboardingId", "department");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_sep_no_dues_certificates_offboardingId_key" ON "hcm_sep_no_dues_certificates"("offboardingId");

-- CreateIndex
CREATE INDEX "hcm_sep_no_dues_certificates_tenantId_employmentRelationshi_idx" ON "hcm_sep_no_dues_certificates"("tenantId", "employmentRelationshipId");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_sep_alumni_records_employmentRelationshipId_key" ON "hcm_sep_alumni_records"("employmentRelationshipId");

-- CreateIndex
CREATE INDEX "hcm_sep_alumni_records_tenantId_personId_idx" ON "hcm_sep_alumni_records"("tenantId", "personId");

-- CreateIndex
CREATE INDEX "hcm_time_shifts_tenantId_active_idx" ON "hcm_time_shifts"("tenantId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_time_shifts_tenantId_code_key" ON "hcm_time_shifts"("tenantId", "code");

-- CreateIndex
CREATE INDEX "hcm_time_roster_assignments_tenantId_employmentRelationship_idx" ON "hcm_time_roster_assignments"("tenantId", "employmentRelationshipId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "hcm_time_roster_assignments_tenantId_shiftId_idx" ON "hcm_time_roster_assignments"("tenantId", "shiftId");

-- CreateIndex
CREATE INDEX "hcm_time_clock_events_tenantId_employmentRelationshipId_occ_idx" ON "hcm_time_clock_events"("tenantId", "employmentRelationshipId", "occurredAt");

-- CreateIndex
CREATE INDEX "hcm_time_timesheets_tenantId_status_idx" ON "hcm_time_timesheets"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_time_timesheets_tenantId_employmentRelationshipId_weekS_key" ON "hcm_time_timesheets"("tenantId", "employmentRelationshipId", "weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_time_timesheets_tenantId_recordCode_key" ON "hcm_time_timesheets"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "hcm_time_timesheet_entries_tenantId_timesheetId_idx" ON "hcm_time_timesheet_entries"("tenantId", "timesheetId");

-- CreateIndex
CREATE INDEX "hcm_time_overtime_requests_tenantId_employmentRelationshipI_idx" ON "hcm_time_overtime_requests"("tenantId", "employmentRelationshipId", "date");

-- CreateIndex
CREATE INDEX "hcm_time_overtime_requests_tenantId_status_idx" ON "hcm_time_overtime_requests"("tenantId", "status");

-- CreateIndex
CREATE INDEX "hcm_time_comp_offs_tenantId_employmentRelationshipId_status_idx" ON "hcm_time_comp_offs"("tenantId", "employmentRelationshipId", "status");

-- CreateIndex
CREATE INDEX "hcm_time_attendance_regularisations_tenantId_employmentRela_idx" ON "hcm_time_attendance_regularisations"("tenantId", "employmentRelationshipId", "date");

-- CreateIndex
CREATE INDEX "hcm_time_attendance_regularisations_tenantId_status_idx" ON "hcm_time_attendance_regularisations"("tenantId", "status");

-- CreateIndex
CREATE INDEX "hcm_workflow_request_types_tenantId_active_idx" ON "hcm_workflow_request_types"("tenantId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_workflow_request_types_tenantId_code_key" ON "hcm_workflow_request_types"("tenantId", "code");

-- CreateIndex
CREATE INDEX "hcm_workflow_requests_tenantId_status_idx" ON "hcm_workflow_requests"("tenantId", "status");

-- CreateIndex
CREATE INDEX "hcm_workflow_requests_tenantId_subjectEmploymentId_idx" ON "hcm_workflow_requests"("tenantId", "subjectEmploymentId");

-- CreateIndex
CREATE INDEX "hcm_workflow_requests_tenantId_requestedById_idx" ON "hcm_workflow_requests"("tenantId", "requestedById");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_workflow_requests_tenantId_recordCode_key" ON "hcm_workflow_requests"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "hcm_workflow_request_approvals_tenantId_approverPartyId_dec_idx" ON "hcm_workflow_request_approvals"("tenantId", "approverPartyId", "decision");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_workflow_request_approvals_tenantId_requestId_level_key" ON "hcm_workflow_request_approvals"("tenantId", "requestId", "level");

-- CreateIndex
CREATE INDEX "hcm_workflow_delegations_tenantId_fromPartyId_toDate_idx" ON "hcm_workflow_delegations"("tenantId", "fromPartyId", "toDate");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_workforce_profile_extensions_employmentRelationshipId_key" ON "hcm_workforce_profile_extensions"("employmentRelationshipId");

-- CreateIndex
CREATE INDEX "hcm_workforce_profile_extensions_tenantId_idx" ON "hcm_workforce_profile_extensions"("tenantId");

-- CreateIndex
CREATE INDEX "hcm_workforce_documents_tenantId_employmentRelationshipId_idx" ON "hcm_workforce_documents"("tenantId", "employmentRelationshipId");

-- CreateIndex
CREATE INDEX "hcm_workforce_documents_tenantId_kind_idx" ON "hcm_workforce_documents"("tenantId", "kind");

-- CreateIndex
CREATE INDEX "hcm_workforce_reporting_lines_tenantId_employmentRelationsh_idx" ON "hcm_workforce_reporting_lines"("tenantId", "employmentRelationshipId");

-- CreateIndex
CREATE INDEX "hcm_workforce_reporting_lines_tenantId_managerEmploymentRel_idx" ON "hcm_workforce_reporting_lines"("tenantId", "managerEmploymentRelationshipId");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_workforce_cost_centres_tenantId_code_key" ON "hcm_workforce_cost_centres"("tenantId", "code");

-- CreateIndex
CREATE INDEX "hcm_workforce_cost_centre_assignments_tenantId_employmentRe_idx" ON "hcm_workforce_cost_centre_assignments"("tenantId", "employmentRelationshipId");

-- CreateIndex
CREATE INDEX "hcm_workforce_locations_tenantId_idx" ON "hcm_workforce_locations"("tenantId");

-- CreateIndex
CREATE INDEX "hcm_workforce_location_assignments_tenantId_employmentRelat_idx" ON "hcm_workforce_location_assignments"("tenantId", "employmentRelationshipId");

-- CreateIndex
CREATE INDEX "hcm_workforce_grades_tenantId_level_idx" ON "hcm_workforce_grades"("tenantId", "level");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_workforce_grades_tenantId_code_key" ON "hcm_workforce_grades"("tenantId", "code");

-- CreateIndex
CREATE INDEX "hcm_workforce_grade_assignments_tenantId_employmentRelation_idx" ON "hcm_workforce_grade_assignments"("tenantId", "employmentRelationshipId");

-- CreateIndex
CREATE INDEX "hcm_workforce_employee_status_changes_tenantId_employmentRe_idx" ON "hcm_workforce_employee_status_changes"("tenantId", "employmentRelationshipId");

-- CreateIndex
CREATE INDEX "hcm_workforce_employee_status_changes_tenantId_status_idx" ON "hcm_workforce_employee_status_changes"("tenantId", "status");

-- CreateIndex
CREATE INDEX "it_assets_tenantId_status_idx" ON "it_assets"("tenantId", "status");

-- CreateIndex
CREATE INDEX "it_assets_tenantId_kind_idx" ON "it_assets"("tenantId", "kind");

-- CreateIndex
CREATE INDEX "it_assets_tenantId_holderPartyId_idx" ON "it_assets"("tenantId", "holderPartyId");

-- CreateIndex
CREATE INDEX "it_assets_tenantId_warrantyEnd_idx" ON "it_assets"("tenantId", "warrantyEnd");

-- CreateIndex
CREATE UNIQUE INDEX "it_assets_tenantId_recordCode_key" ON "it_assets"("tenantId", "recordCode");

-- CreateIndex
CREATE UNIQUE INDEX "it_assets_tenantId_tag_key" ON "it_assets"("tenantId", "tag");

-- CreateIndex
CREATE INDEX "it_asset_assignments_tenantId_assetId_idx" ON "it_asset_assignments"("tenantId", "assetId");

-- CreateIndex
CREATE INDEX "it_asset_assignments_tenantId_partyId_idx" ON "it_asset_assignments"("tenantId", "partyId");

-- CreateIndex
CREATE INDEX "it_asset_assignments_tenantId_returnedAt_idx" ON "it_asset_assignments"("tenantId", "returnedAt");

-- CreateIndex
CREATE INDEX "it_asset_events_tenantId_assetId_idx" ON "it_asset_events"("tenantId", "assetId");

-- CreateIndex
CREATE INDEX "it_asset_events_tenantId_kind_idx" ON "it_asset_events"("tenantId", "kind");

-- CreateIndex
CREATE INDEX "it_asset_thresholds_tenantId_code_effectiveFrom_idx" ON "it_asset_thresholds"("tenantId", "code", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "it_asset_thresholds_tenantId_code_effectiveFrom_key" ON "it_asset_thresholds"("tenantId", "code", "effectiveFrom");

-- CreateIndex
CREATE INDEX "it_continuity_plans_tenantId_status_idx" ON "it_continuity_plans"("tenantId", "status");

-- CreateIndex
CREATE INDEX "it_continuity_plans_tenantId_applicationId_idx" ON "it_continuity_plans"("tenantId", "applicationId");

-- CreateIndex
CREATE INDEX "it_continuity_plans_tenantId_applicationTier_status_idx" ON "it_continuity_plans"("tenantId", "applicationTier", "status");

-- CreateIndex
CREATE UNIQUE INDEX "it_continuity_plans_tenantId_recordCode_key" ON "it_continuity_plans"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "it_continuity_tests_tenantId_planId_testedAt_idx" ON "it_continuity_tests"("tenantId", "planId", "testedAt");

-- CreateIndex
CREATE UNIQUE INDEX "it_continuity_tests_tenantId_recordCode_key" ON "it_continuity_tests"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "it_availability_readings_tenantId_period_idx" ON "it_availability_readings"("tenantId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "it_availability_readings_tenantId_applicationId_period_key" ON "it_availability_readings"("tenantId", "applicationId", "period");

-- CreateIndex
CREATE INDEX "it_maintenance_windows_tenantId_startsAt_idx" ON "it_maintenance_windows"("tenantId", "startsAt");

-- CreateIndex
CREATE INDEX "it_maintenance_windows_tenantId_status_idx" ON "it_maintenance_windows"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "it_maintenance_windows_tenantId_recordCode_key" ON "it_maintenance_windows"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "it_risk_scoring_bands_tenantId_effectiveFrom_idx" ON "it_risk_scoring_bands"("tenantId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "it_risk_scoring_bands_tenantId_setId_idx" ON "it_risk_scoring_bands"("tenantId", "setId");

-- CreateIndex
CREATE INDEX "it_risks_tenantId_status_idx" ON "it_risks"("tenantId", "status");

-- CreateIndex
CREATE INDEX "it_risks_tenantId_bandResidual_idx" ON "it_risks"("tenantId", "bandResidual");

-- CreateIndex
CREATE INDEX "it_risks_tenantId_reviewDueAt_idx" ON "it_risks"("tenantId", "reviewDueAt");

-- CreateIndex
CREATE UNIQUE INDEX "it_risks_tenantId_recordCode_key" ON "it_risks"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "it_policy_documents_tenantId_code_status_idx" ON "it_policy_documents"("tenantId", "code", "status");

-- CreateIndex
CREATE UNIQUE INDEX "it_policy_documents_tenantId_code_version_key" ON "it_policy_documents"("tenantId", "code", "version");

-- CreateIndex
CREATE UNIQUE INDEX "it_policy_documents_tenantId_recordCode_key" ON "it_policy_documents"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "it_policy_acknowledgements_tenantId_partyId_idx" ON "it_policy_acknowledgements"("tenantId", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "it_policy_acknowledgements_tenantId_policyId_partyId_versio_key" ON "it_policy_acknowledgements"("tenantId", "policyId", "partyId", "version");

-- CreateIndex
CREATE INDEX "it_controls_tenantId_status_idx" ON "it_controls"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "it_controls_tenantId_code_key" ON "it_controls"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "it_controls_tenantId_recordCode_key" ON "it_controls"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "it_control_tests_tenantId_controlId_testedAt_idx" ON "it_control_tests"("tenantId", "controlId", "testedAt");

-- CreateIndex
CREATE INDEX "it_access_reviews_tenantId_status_idx" ON "it_access_reviews"("tenantId", "status");

-- CreateIndex
CREATE INDEX "it_access_reviews_tenantId_dueAt_idx" ON "it_access_reviews"("tenantId", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "it_access_reviews_tenantId_recordCode_key" ON "it_access_reviews"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "it_access_review_items_tenantId_reviewId_idx" ON "it_access_review_items"("tenantId", "reviewId");

-- CreateIndex
CREATE INDEX "it_access_review_items_tenantId_partyId_idx" ON "it_access_review_items"("tenantId", "partyId");

-- CreateIndex
CREATE INDEX "it_remediation_rules_tenantId_severity_effectiveFrom_idx" ON "it_remediation_rules"("tenantId", "severity", "effectiveFrom");

-- CreateIndex
CREATE INDEX "it_security_findings_tenantId_status_idx" ON "it_security_findings"("tenantId", "status");

-- CreateIndex
CREATE INDEX "it_security_findings_tenantId_severity_status_idx" ON "it_security_findings"("tenantId", "severity", "status");

-- CreateIndex
CREATE INDEX "it_security_findings_tenantId_dueAt_idx" ON "it_security_findings"("tenantId", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "it_security_findings_tenantId_recordCode_key" ON "it_security_findings"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "it_incidents_tenantId_status_idx" ON "it_incidents"("tenantId", "status");

-- CreateIndex
CREATE INDEX "it_incidents_tenantId_severity_idx" ON "it_incidents"("tenantId", "severity");

-- CreateIndex
CREATE INDEX "it_incidents_tenantId_problemId_idx" ON "it_incidents"("tenantId", "problemId");

-- CreateIndex
CREATE UNIQUE INDEX "it_incidents_tenantId_recordCode_key" ON "it_incidents"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "it_incident_updates_tenantId_incidentId_idx" ON "it_incident_updates"("tenantId", "incidentId");

-- CreateIndex
CREATE INDEX "it_problems_tenantId_status_idx" ON "it_problems"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "it_problems_tenantId_recordCode_key" ON "it_problems"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "it_changes_tenantId_status_idx" ON "it_changes"("tenantId", "status");

-- CreateIndex
CREATE INDEX "it_changes_tenantId_requesterPartyId_idx" ON "it_changes"("tenantId", "requesterPartyId");

-- CreateIndex
CREATE INDEX "it_changes_tenantId_windowStart_idx" ON "it_changes"("tenantId", "windowStart");

-- CreateIndex
CREATE UNIQUE INDEX "it_changes_tenantId_recordCode_key" ON "it_changes"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "it_change_freezes_tenantId_startsAt_idx" ON "it_change_freezes"("tenantId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "it_itsm_policies_tenantId_key" ON "it_itsm_policies"("tenantId");

-- CreateIndex
CREATE INDEX "it_initiatives_tenantId_stage_idx" ON "it_initiatives"("tenantId", "stage");

-- CreateIndex
CREATE INDEX "it_initiatives_tenantId_theme_idx" ON "it_initiatives"("tenantId", "theme");

-- CreateIndex
CREATE UNIQUE INDEX "it_initiatives_tenantId_recordCode_key" ON "it_initiatives"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "it_initiative_updates_tenantId_initiativeId_at_idx" ON "it_initiative_updates"("tenantId", "initiativeId", "at");

-- CreateIndex
CREATE INDEX "it_roadmap_items_tenantId_quarter_idx" ON "it_roadmap_items"("tenantId", "quarter");

-- CreateIndex
CREATE INDEX "it_roadmap_items_tenantId_theme_idx" ON "it_roadmap_items"("tenantId", "theme");

-- CreateIndex
CREATE INDEX "it_budget_lines_tenantId_fy_idx" ON "it_budget_lines"("tenantId", "fy");

-- CreateIndex
CREATE INDEX "it_budget_lines_tenantId_status_idx" ON "it_budget_lines"("tenantId", "status");

-- CreateIndex
CREATE INDEX "it_tech_debt_items_tenantId_status_idx" ON "it_tech_debt_items"("tenantId", "status");

-- CreateIndex
CREATE INDEX "it_tech_debt_items_tenantId_severity_idx" ON "it_tech_debt_items"("tenantId", "severity");

-- CreateIndex
CREATE UNIQUE INDEX "it_tech_debt_items_tenantId_recordCode_key" ON "it_tech_debt_items"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "it_portfolio_settings_tenantId_key_effectiveFrom_idx" ON "it_portfolio_settings"("tenantId", "key", "effectiveFrom");

-- CreateIndex
CREATE INDEX "it_sla_policies_tenantId_priority_effectiveFrom_idx" ON "it_sla_policies"("tenantId", "priority", "effectiveFrom");

-- CreateIndex
CREATE INDEX "it_tickets_tenantId_status_idx" ON "it_tickets"("tenantId", "status");

-- CreateIndex
CREATE INDEX "it_tickets_tenantId_requesterPartyId_idx" ON "it_tickets"("tenantId", "requesterPartyId");

-- CreateIndex
CREATE INDEX "it_tickets_tenantId_assigneePartyId_idx" ON "it_tickets"("tenantId", "assigneePartyId");

-- CreateIndex
CREATE INDEX "it_tickets_tenantId_priority_status_idx" ON "it_tickets"("tenantId", "priority", "status");

-- CreateIndex
CREATE UNIQUE INDEX "it_tickets_tenantId_recordCode_key" ON "it_tickets"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "it_ticket_comments_tenantId_ticketId_idx" ON "it_ticket_comments"("tenantId", "ticketId");

-- CreateIndex
CREATE INDEX "it_knowledge_articles_tenantId_status_idx" ON "it_knowledge_articles"("tenantId", "status");

-- CreateIndex
CREATE INDEX "it_knowledge_articles_tenantId_applicationId_idx" ON "it_knowledge_articles"("tenantId", "applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "it_knowledge_articles_tenantId_recordCode_key" ON "it_knowledge_articles"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "it_applications_tenantId_status_idx" ON "it_applications"("tenantId", "status");

-- CreateIndex
CREATE INDEX "it_applications_tenantId_tier_idx" ON "it_applications"("tenantId", "tier");

-- CreateIndex
CREATE INDEX "it_applications_tenantId_ownerPartyId_idx" ON "it_applications"("tenantId", "ownerPartyId");

-- CreateIndex
CREATE UNIQUE INDEX "it_applications_tenantId_recordCode_key" ON "it_applications"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "it_licences_tenantId_status_idx" ON "it_licences"("tenantId", "status");

-- CreateIndex
CREATE INDEX "it_licences_tenantId_applicationId_idx" ON "it_licences"("tenantId", "applicationId");

-- CreateIndex
CREATE INDEX "it_licences_tenantId_renewalDate_idx" ON "it_licences"("tenantId", "renewalDate");

-- CreateIndex
CREATE UNIQUE INDEX "it_licences_tenantId_recordCode_key" ON "it_licences"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "it_licence_events_tenantId_licenceId_idx" ON "it_licence_events"("tenantId", "licenceId");

-- CreateIndex
CREATE INDEX "it_software_thresholds_tenantId_effectiveFrom_idx" ON "it_software_thresholds"("tenantId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "it_software_thresholds_tenantId_code_key" ON "it_software_thresholds"("tenantId", "code");

-- CreateIndex
CREATE INDEX "it_vendors_tenantId_status_idx" ON "it_vendors"("tenantId", "status");

-- CreateIndex
CREATE INDEX "it_vendors_tenantId_tier_idx" ON "it_vendors"("tenantId", "tier");

-- CreateIndex
CREATE INDEX "it_vendors_tenantId_riskRating_idx" ON "it_vendors"("tenantId", "riskRating");

-- CreateIndex
CREATE UNIQUE INDEX "it_vendors_tenantId_recordCode_key" ON "it_vendors"("tenantId", "recordCode");

-- CreateIndex
CREATE UNIQUE INDEX "it_vendor_assessment_cadence_rules_tenantId_tier_key" ON "it_vendor_assessment_cadence_rules"("tenantId", "tier");

-- CreateIndex
CREATE INDEX "it_vendor_risk_assessments_tenantId_vendorId_idx" ON "it_vendor_risk_assessments"("tenantId", "vendorId");

-- CreateIndex
CREATE INDEX "it_vendor_contracts_tenantId_status_idx" ON "it_vendor_contracts"("tenantId", "status");

-- CreateIndex
CREATE INDEX "it_vendor_contracts_tenantId_vendorId_idx" ON "it_vendor_contracts"("tenantId", "vendorId");

-- CreateIndex
CREATE INDEX "it_vendor_contracts_tenantId_endDate_idx" ON "it_vendor_contracts"("tenantId", "endDate");

-- CreateIndex
CREATE UNIQUE INDEX "it_vendor_contracts_tenantId_recordCode_key" ON "it_vendor_contracts"("tenantId", "recordCode");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "record_sequences_tenantId_entityType_year_key" ON "record_sequences"("tenantId", "entityType", "year");

-- CreateIndex
CREATE UNIQUE INDEX "company_profiles_tenantId_key" ON "company_profiles"("tenantId");

-- CreateIndex
CREATE INDEX "people_tenantId_primaryPhoneNormalised_idx" ON "people"("tenantId", "primaryPhoneNormalised");

-- CreateIndex
CREATE INDEX "people_tenantId_primaryEmailNormalised_idx" ON "people"("tenantId", "primaryEmailNormalised");

-- CreateIndex
CREATE INDEX "people_tenantId_dedupeStatus_idx" ON "people"("tenantId", "dedupeStatus");

-- CreateIndex
CREATE INDEX "people_tenantId_fullName_idx" ON "people"("tenantId", "fullName");

-- CreateIndex
CREATE UNIQUE INDEX "people_tenantId_recordCode_key" ON "people"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "affiliations_tenantId_partyId_status_idx" ON "affiliations"("tenantId", "partyId", "status");

-- CreateIndex
CREATE INDEX "affiliations_tenantId_affiliationType_status_idx" ON "affiliations"("tenantId", "affiliationType", "status");

-- CreateIndex
CREATE INDEX "merge_candidates_tenantId_state_createdAt_idx" ON "merge_candidates"("tenantId", "state", "createdAt");

-- CreateIndex
CREATE INDEX "organizations_tenantId_name_idx" ON "organizations"("tenantId", "name");

-- CreateIndex
CREATE INDEX "organizations_tenantId_kind_name_idx" ON "organizations"("tenantId", "kind", "name");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_tenantId_recordCode_key" ON "organizations"("tenantId", "recordCode");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_organizationId_key" ON "accounts"("organizationId");

-- CreateIndex
CREATE INDEX "accounts_tenantId_tier_idx" ON "accounts"("tenantId", "tier");

-- CreateIndex
CREATE UNIQUE INDEX "institution_profiles_organizationId_key" ON "institution_profiles"("organizationId");

-- CreateIndex
CREATE INDEX "institution_profiles_tenantId_district_institutionType_idx" ON "institution_profiles"("tenantId", "district", "institutionType");

-- CreateIndex
CREATE INDEX "institution_profiles_tenantId_externalIdentifier_idx" ON "institution_profiles"("tenantId", "externalIdentifier");

-- CreateIndex
CREATE UNIQUE INDEX "student_profiles_personId_key" ON "student_profiles"("personId");

-- CreateIndex
CREATE INDEX "student_profiles_tenantId_status_idx" ON "student_profiles"("tenantId", "status");

-- CreateIndex
CREATE INDEX "student_profiles_tenantId_institutionId_idx" ON "student_profiles"("tenantId", "institutionId");

-- CreateIndex
CREATE INDEX "student_profiles_tenantId_funding_idx" ON "student_profiles"("tenantId", "funding");

-- CreateIndex
CREATE INDEX "student_profiles_tenantId_sponsorId_idx" ON "student_profiles"("tenantId", "sponsorId");

-- CreateIndex
CREATE INDEX "student_profiles_tenantId_fundingFramework_idx" ON "student_profiles"("tenantId", "fundingFramework");

-- CreateIndex
CREATE UNIQUE INDEX "student_profiles_tenantId_registrationNumber_key" ON "student_profiles"("tenantId", "registrationNumber");

-- CreateIndex
CREATE INDEX "relationships_tenantId_fromType_fromId_idx" ON "relationships"("tenantId", "fromType", "fromId");

-- CreateIndex
CREATE INDEX "relationships_tenantId_toType_toId_idx" ON "relationships"("tenantId", "toType", "toId");

-- CreateIndex
CREATE INDEX "relationships_tenantId_relationshipType_status_idx" ON "relationships"("tenantId", "relationshipType", "status");

-- CreateIndex
CREATE UNIQUE INDEX "access_roles_tenantId_slug_key" ON "access_roles"("tenantId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "policies_tenantId_policyCode_key" ON "policies"("tenantId", "policyCode");

-- CreateIndex
CREATE INDEX "policy_versions_tenantId_effectiveFrom_idx" ON "policy_versions"("tenantId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "policy_versions_policyId_version_key" ON "policy_versions"("policyId", "version");

-- CreateIndex
CREATE INDEX "grants_tenantId_roleId_resource_idx" ON "grants"("tenantId", "roleId", "resource");

-- CreateIndex
CREATE INDEX "grants_tenantId_principalId_resource_idx" ON "grants"("tenantId", "principalId", "resource");

-- CreateIndex
CREATE INDEX "authority_grants_tenantId_principalId_authorityClass_idx" ON "authority_grants"("tenantId", "principalId", "authorityClass");

-- CreateIndex
CREATE INDEX "approval_steps_tenantId_state_slaDueAt_idx" ON "approval_steps"("tenantId", "state", "slaDueAt");

-- CreateIndex
CREATE INDEX "approval_steps_tenantId_resolvedApproverId_state_idx" ON "approval_steps"("tenantId", "resolvedApproverId", "state");

-- CreateIndex
CREATE INDEX "decisions_tenantId_state_raisedAt_idx" ON "decisions"("tenantId", "state", "raisedAt");

-- CreateIndex
CREATE INDEX "decisions_tenantId_routedToPartyId_state_idx" ON "decisions"("tenantId", "routedToPartyId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "decisions_tenantId_recordCode_key" ON "decisions"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "delegations_tenantId_toPartyId_state_idx" ON "delegations"("tenantId", "toPartyId", "state");

-- CreateIndex
CREATE INDEX "event_records_tenantId_recordedAt_idx" ON "event_records"("tenantId", "recordedAt");

-- CreateIndex
CREATE INDEX "event_records_tenantId_eventName_occurredAt_idx" ON "event_records"("tenantId", "eventName", "occurredAt");

-- CreateIndex
CREATE INDEX "event_records_tenantId_subjectEntityType_subjectEntityId_idx" ON "event_records"("tenantId", "subjectEntityType", "subjectEntityId");

-- CreateIndex
CREATE INDEX "event_records_tenantId_correlationId_idx" ON "event_records"("tenantId", "correlationId");

-- CreateIndex
CREATE UNIQUE INDEX "event_records_tenantId_eventId_eventName_key" ON "event_records"("tenantId", "eventId", "eventName");

-- CreateIndex
CREATE UNIQUE INDEX "event_records_tenantId_prevHash_key" ON "event_records"("tenantId", "prevHash");

-- CreateIndex
CREATE INDEX "event_dead_letters_tenantId_state_createdAt_idx" ON "event_dead_letters"("tenantId", "state", "createdAt");

-- CreateIndex
CREATE INDEX "job_claims_tenantId_status_scheduledFor_idx" ON "job_claims"("tenantId", "status", "scheduledFor");

-- CreateIndex
CREATE UNIQUE INDEX "job_claims_tenantId_jobName_scheduledFor_key" ON "job_claims"("tenantId", "jobName", "scheduledFor");

-- CreateIndex
CREATE INDEX "audit_records_tenantId_subjectType_subjectId_timestamp_idx" ON "audit_records"("tenantId", "subjectType", "subjectId", "timestamp");

-- CreateIndex
CREATE INDEX "audit_records_tenantId_actorId_timestamp_idx" ON "audit_records"("tenantId", "actorId", "timestamp");

-- CreateIndex
CREATE INDEX "audit_records_tenantId_timestamp_idx" ON "audit_records"("tenantId", "timestamp");

-- CreateIndex
CREATE INDEX "users_tenantId_personId_idx" ON "users"("tenantId", "personId");

-- CreateIndex
CREATE INDEX "users_principalId_idx" ON "users"("principalId");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenantId_email_key" ON "users"("tenantId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "principals_email_key" ON "principals"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_jti_key" ON "sessions"("jti");

-- CreateIndex
CREATE INDEX "sessions_tenantId_userId_idx" ON "sessions"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "attention_watermarks_tenantId_userId_affiliationId_key" ON "attention_watermarks"("tenantId", "userId", "affiliationId");

-- CreateIndex
CREATE INDEX "pipeline_definitions_tenantId_effectiveFrom_idx" ON "pipeline_definitions"("tenantId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "pipeline_definitions_tenantId_pipelineCode_key" ON "pipeline_definitions"("tenantId", "pipelineCode");

-- CreateIndex
CREATE INDEX "pipeline_stages_tenantId_pipelineId_pipelinePosition_idx" ON "pipeline_stages"("tenantId", "pipelineId", "pipelinePosition");

-- CreateIndex
CREATE UNIQUE INDEX "pipeline_stages_pipelineId_stageKey_key" ON "pipeline_stages"("pipelineId", "stageKey");

-- CreateIndex
CREATE UNIQUE INDEX "pipeline_stages_pipelineId_sequence_key" ON "pipeline_stages"("pipelineId", "sequence");

-- CreateIndex
CREATE INDEX "pipeline_transitions_tenantId_pipelineId_idx" ON "pipeline_transitions"("tenantId", "pipelineId");

-- CreateIndex
CREATE UNIQUE INDEX "pipeline_transitions_pipelineId_fromStageKey_toStageKey_key" ON "pipeline_transitions"("pipelineId", "fromStageKey", "toStageKey");

-- CreateIndex
CREATE INDEX "territories_tenantId_active_idx" ON "territories"("tenantId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "territories_tenantId_recordCode_key" ON "territories"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "routing_rules_tenantId_active_priority_idx" ON "routing_rules"("tenantId", "active", "priority");

-- CreateIndex
CREATE INDEX "routing_audits_tenantId_leadId_idx" ON "routing_audits"("tenantId", "leadId");

-- CreateIndex
CREATE INDEX "capability_claims_tenantId_partyId_idx" ON "capability_claims"("tenantId", "partyId");

-- CreateIndex
CREATE INDEX "capability_claims_tenantId_skillId_tier_idx" ON "capability_claims"("tenantId", "skillId", "tier");

-- CreateIndex
CREATE INDEX "capability_claims_tenantId_state_idx" ON "capability_claims"("tenantId", "state");

-- CreateIndex
CREATE INDEX "leads_tenantId_leadStatus_ownerPartyId_idx" ON "leads"("tenantId", "leadStatus", "ownerPartyId");

-- CreateIndex
CREATE INDEX "leads_tenantId_pipelineId_stageKey_idx" ON "leads"("tenantId", "pipelineId", "stageKey");

-- CreateIndex
CREATE INDEX "leads_tenantId_createdAt_idx" ON "leads"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "leads_tenantId_campaignId_idx" ON "leads"("tenantId", "campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "leads_tenantId_recordCode_key" ON "leads"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "opportunities_tenantId_pipelineId_stageKey_idx" ON "opportunities"("tenantId", "pipelineId", "stageKey");

-- CreateIndex
CREATE INDEX "opportunities_tenantId_forecastCategory_idx" ON "opportunities"("tenantId", "forecastCategory");

-- CreateIndex
CREATE INDEX "opportunities_tenantId_ownerPartyId_idx" ON "opportunities"("tenantId", "ownerPartyId");

-- CreateIndex
CREATE INDEX "opportunities_tenantId_expectedCloseDate_idx" ON "opportunities"("tenantId", "expectedCloseDate");

-- CreateIndex
CREATE UNIQUE INDEX "opportunities_tenantId_recordCode_key" ON "opportunities"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "offerings_tenantId_status_vertical_idx" ON "offerings"("tenantId", "status", "vertical");

-- CreateIndex
CREATE UNIQUE INDEX "offerings_tenantId_offeringCode_key" ON "offerings"("tenantId", "offeringCode");

-- CreateIndex
CREATE INDEX "price_book_entries_tenantId_offeringId_status_idx" ON "price_book_entries"("tenantId", "offeringId", "status");

-- CreateIndex
CREATE INDEX "price_book_entries_tenantId_priceBookId_currency_idx" ON "price_book_entries"("tenantId", "priceBookId", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "price_book_entries_offeringId_priceBookId_version_key" ON "price_book_entries"("offeringId", "priceBookId", "version");

-- CreateIndex
CREATE INDEX "proposals_tenantId_opportunityId_idx" ON "proposals"("tenantId", "opportunityId");

-- CreateIndex
CREATE INDEX "proposals_tenantId_response_sentAt_idx" ON "proposals"("tenantId", "response", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "proposals_tenantId_recordCode_key" ON "proposals"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "quotes_tenantId_opportunityId_version_idx" ON "quotes"("tenantId", "opportunityId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_tenantId_recordCode_key" ON "quotes"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "quote_lines_tenantId_quote_id_idx" ON "quote_lines"("tenantId", "quote_id");

-- CreateIndex
CREATE INDEX "mous_tenantId_status_endDate_idx" ON "mous"("tenantId", "status", "endDate");

-- CreateIndex
CREATE INDEX "mous_tenantId_organizationId_idx" ON "mous"("tenantId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "mous_tenantId_recordCode_key" ON "mous"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "contracts_tenantId_status_endDate_idx" ON "contracts"("tenantId", "status", "endDate");

-- CreateIndex
CREATE INDEX "contracts_tenantId_opportunityId_idx" ON "contracts"("tenantId", "opportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "contracts_tenantId_recordCode_key" ON "contracts"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "partner_agreements_tenantId_status_endDate_idx" ON "partner_agreements"("tenantId", "status", "endDate");

-- CreateIndex
CREATE INDEX "partner_agreements_tenantId_partnerOrganizationId_idx" ON "partner_agreements"("tenantId", "partnerOrganizationId");

-- CreateIndex
CREATE UNIQUE INDEX "partner_agreements_tenantId_recordCode_key" ON "partner_agreements"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "win_loss_reviews_tenantId_mandatory_completedAt_idx" ON "win_loss_reviews"("tenantId", "mandatory", "completedAt");

-- CreateIndex
CREATE UNIQUE INDEX "win_loss_reviews_tenantId_recordCode_key" ON "win_loss_reviews"("tenantId", "recordCode");

-- CreateIndex
CREATE UNIQUE INDEX "win_loss_reviews_tenantId_subjectType_subjectId_key" ON "win_loss_reviews"("tenantId", "subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "interactions_tenantId_occurredAt_idx" ON "interactions"("tenantId", "occurredAt");

-- CreateIndex
CREATE INDEX "interactions_tenantId_sensitivityClass_idx" ON "interactions"("tenantId", "sensitivityClass");

-- CreateIndex
CREATE INDEX "interactions_tenantId_actorPartyId_idx" ON "interactions"("tenantId", "actorPartyId");

-- CreateIndex
CREATE UNIQUE INDEX "interactions_tenantId_recordCode_key" ON "interactions"("tenantId", "recordCode");

-- CreateIndex
CREATE UNIQUE INDEX "sensitivity_registrations_tenantId_contextCode_entityType_key" ON "sensitivity_registrations"("tenantId", "contextCode", "entityType");

-- CreateIndex
CREATE INDEX "tasks_tenantId_assigneePartyId_status_idx" ON "tasks"("tenantId", "assigneePartyId", "status");

-- CreateIndex
CREATE INDEX "tasks_tenantId_dueAt_status_idx" ON "tasks"("tenantId", "dueAt", "status");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_tenantId_recordCode_key" ON "tasks"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "documents_tenantId_attachedToType_attachedToId_idx" ON "documents"("tenantId", "attachedToType", "attachedToId");

-- CreateIndex
CREATE INDEX "documents_tenantId_documentGroupId_version_idx" ON "documents"("tenantId", "documentGroupId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "documents_tenantId_recordCode_key" ON "documents"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "notes_tenantId_attachedToType_attachedToId_idx" ON "notes"("tenantId", "attachedToType", "attachedToId");

-- CreateIndex
CREATE INDEX "share_classes_tenantId_status_idx" ON "share_classes"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "share_classes_tenantId_recordCode_key" ON "share_classes"("tenantId", "recordCode");

-- CreateIndex
CREATE UNIQUE INDEX "share_classes_tenantId_name_key" ON "share_classes"("tenantId", "name");

-- CreateIndex
CREATE INDEX "holders_tenantId_status_idx" ON "holders"("tenantId", "status");

-- CreateIndex
CREATE INDEX "holders_tenantId_personId_idx" ON "holders"("tenantId", "personId");

-- CreateIndex
CREATE INDEX "holders_tenantId_organizationId_idx" ON "holders"("tenantId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "holders_tenantId_recordCode_key" ON "holders"("tenantId", "recordCode");

-- CreateIndex
CREATE UNIQUE INDEX "holders_tenantId_folioNumber_key" ON "holders"("tenantId", "folioNumber");

-- CreateIndex
CREATE INDEX "share_transactions_tenantId_status_idx" ON "share_transactions"("tenantId", "status");

-- CreateIndex
CREATE INDEX "share_transactions_tenantId_shareClassId_status_idx" ON "share_transactions"("tenantId", "shareClassId", "status");

-- CreateIndex
CREATE INDEX "share_transactions_tenantId_toHolderId_idx" ON "share_transactions"("tenantId", "toHolderId");

-- CreateIndex
CREATE INDEX "share_transactions_tenantId_fromHolderId_idx" ON "share_transactions"("tenantId", "fromHolderId");

-- CreateIndex
CREATE INDEX "share_transactions_tenantId_roundId_idx" ON "share_transactions"("tenantId", "roundId");

-- CreateIndex
CREATE UNIQUE INDEX "share_transactions_tenantId_recordCode_key" ON "share_transactions"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "share_certificates_tenantId_holderId_status_idx" ON "share_certificates"("tenantId", "holderId", "status");

-- CreateIndex
CREATE INDEX "share_certificates_tenantId_shareClassId_idx" ON "share_certificates"("tenantId", "shareClassId");

-- CreateIndex
CREATE UNIQUE INDEX "share_certificates_tenantId_recordCode_key" ON "share_certificates"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "valuations_tenantId_asOf_idx" ON "valuations"("tenantId", "asOf");

-- CreateIndex
CREATE INDEX "valuations_tenantId_roundId_idx" ON "valuations"("tenantId", "roundId");

-- CreateIndex
CREATE UNIQUE INDEX "valuations_tenantId_recordCode_key" ON "valuations"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "funding_rounds_tenantId_status_idx" ON "funding_rounds"("tenantId", "status");

-- CreateIndex
CREATE INDEX "funding_rounds_tenantId_kind_idx" ON "funding_rounds"("tenantId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "funding_rounds_tenantId_recordCode_key" ON "funding_rounds"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "filings_tenantId_form_idx" ON "filings"("tenantId", "form");

-- CreateIndex
CREATE INDEX "filings_tenantId_relatedType_relatedId_idx" ON "filings"("tenantId", "relatedType", "relatedId");

-- CreateIndex
CREATE UNIQUE INDEX "filings_tenantId_recordCode_key" ON "filings"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "entity_documents_tenantId_audience_idx" ON "entity_documents"("tenantId", "audience");

-- CreateIndex
CREATE INDEX "entity_documents_tenantId_relatedType_relatedId_idx" ON "entity_documents"("tenantId", "relatedType", "relatedId");

-- CreateIndex
CREATE UNIQUE INDEX "entity_documents_tenantId_recordCode_key" ON "entity_documents"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "entity_snapshots_tenantId_asOf_idx" ON "entity_snapshots"("tenantId", "asOf");

-- CreateIndex
CREATE UNIQUE INDEX "entity_snapshots_tenantId_sourceTenantId_key" ON "entity_snapshots"("tenantId", "sourceTenantId");

-- CreateIndex
CREATE UNIQUE INDEX "entity_snapshots_tenantId_recordCode_key" ON "entity_snapshots"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "entity_snapshot_history_tenantId_sourceTenantId_publishedAt_idx" ON "entity_snapshot_history"("tenantId", "sourceTenantId", "publishedAt");

-- CreateIndex
CREATE INDEX "esop_plans_tenantId_status_idx" ON "esop_plans"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "esop_plans_tenantId_recordCode_key" ON "esop_plans"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "option_grants_tenantId_status_idx" ON "option_grants"("tenantId", "status");

-- CreateIndex
CREATE INDEX "option_grants_tenantId_personId_idx" ON "option_grants"("tenantId", "personId");

-- CreateIndex
CREATE INDEX "option_grants_tenantId_employmentId_idx" ON "option_grants"("tenantId", "employmentId");

-- CreateIndex
CREATE INDEX "option_grants_tenantId_planId_idx" ON "option_grants"("tenantId", "planId");

-- CreateIndex
CREATE UNIQUE INDEX "option_grants_tenantId_recordCode_key" ON "option_grants"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "vesting_events_tenantId_grantId_status_idx" ON "vesting_events"("tenantId", "grantId", "status");

-- CreateIndex
CREATE INDEX "vesting_events_tenantId_status_on_idx" ON "vesting_events"("tenantId", "status", "on");

-- CreateIndex
CREATE INDEX "option_exercises_tenantId_grantId_status_idx" ON "option_exercises"("tenantId", "grantId", "status");

-- CreateIndex
CREATE INDEX "option_exercises_tenantId_status_idx" ON "option_exercises"("tenantId", "status");

-- CreateIndex
CREATE INDEX "invoices_tenantId_status_dueDate_idx" ON "invoices"("tenantId", "status", "dueDate");

-- CreateIndex
CREATE INDEX "invoices_tenantId_accountId_idx" ON "invoices"("tenantId", "accountId");

-- CreateIndex
CREATE INDEX "invoices_tenantId_personId_idx" ON "invoices"("tenantId", "personId");

-- CreateIndex
CREATE INDEX "invoices_tenantId_createdById_idx" ON "invoices"("tenantId", "createdById");

-- CreateIndex
CREATE INDEX "invoices_tenantId_gstFilingId_idx" ON "invoices"("tenantId", "gstFilingId");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_tenantId_recordCode_key" ON "invoices"("tenantId", "recordCode");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_tenantId_draftReference_key" ON "invoices"("tenantId", "draftReference");

-- CreateIndex
CREATE INDEX "invoice_lines_tenantId_invoiceId_idx" ON "invoice_lines"("tenantId", "invoiceId");

-- CreateIndex
CREATE INDEX "invoice_lines_tenantId_enrollmentId_idx" ON "invoice_lines"("tenantId", "enrollmentId");

-- CreateIndex
CREATE INDEX "invoice_lines_tenantId_courseId_idx" ON "invoice_lines"("tenantId", "courseId");

-- CreateIndex
CREATE INDEX "invoice_lines_tenantId_courseAddonId_idx" ON "invoice_lines"("tenantId", "courseAddonId");

-- CreateIndex
CREATE INDEX "fee_instalments_tenantId_status_dueDate_idx" ON "fee_instalments"("tenantId", "status", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "fee_instalments_tenantId_recordCode_key" ON "fee_instalments"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "payments_tenantId_receivedAt_idx" ON "payments"("tenantId", "receivedAt");

-- CreateIndex
CREATE INDEX "payments_tenantId_status_idx" ON "payments"("tenantId", "status");

-- CreateIndex
CREATE INDEX "payments_tenantId_recordedById_idx" ON "payments"("tenantId", "recordedById");

-- CreateIndex
CREATE UNIQUE INDEX "payments_tenantId_gatewayReference_key" ON "payments"("tenantId", "gatewayReference");

-- CreateIndex
CREATE UNIQUE INDEX "payments_tenantId_recordCode_key" ON "payments"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "receipts_tenantId_paymentId_idx" ON "receipts"("tenantId", "paymentId");

-- CreateIndex
CREATE INDEX "receipts_tenantId_invoiceId_idx" ON "receipts"("tenantId", "invoiceId");

-- CreateIndex
CREATE INDEX "receipts_tenantId_allocatedAt_idx" ON "receipts"("tenantId", "allocatedAt");

-- CreateIndex
CREATE INDEX "receipts_tenantId_legacyReference_idx" ON "receipts"("tenantId", "legacyReference");

-- CreateIndex
CREATE UNIQUE INDEX "receipts_tenantId_recordCode_key" ON "receipts"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "final_invoices_tenantId_invoiceId_status_idx" ON "final_invoices"("tenantId", "invoiceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "final_invoices_tenantId_recordCode_key" ON "final_invoices"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "credit_notes_tenantId_invoiceId_idx" ON "credit_notes"("tenantId", "invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_tenantId_recordCode_key" ON "credit_notes"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "gst_filings_tenantId_returnType_period_status_idx" ON "gst_filings"("tenantId", "returnType", "period", "status");

-- CreateIndex
CREATE INDEX "gst_filings_tenantId_period_idx" ON "gst_filings"("tenantId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "gst_filings_tenantId_recordCode_key" ON "gst_filings"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "receivables_projections_tenantId_dunningStage_idx" ON "receivables_projections"("tenantId", "dunningStage");

-- CreateIndex
CREATE UNIQUE INDEX "receivables_projections_tenantId_subjectType_subjectId_key" ON "receivables_projections"("tenantId", "subjectType", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "courses_tenantId_recordCode_key" ON "courses"("tenantId", "recordCode");

-- CreateIndex
CREATE UNIQUE INDEX "courses_tenantId_code_key" ON "courses"("tenantId", "code");

-- CreateIndex
CREATE INDEX "course_fee_plans_tenantId_courseId_idx" ON "course_fee_plans"("tenantId", "courseId");

-- CreateIndex
CREATE UNIQUE INDEX "course_fee_plans_courseId_tenureMonths_key" ON "course_fee_plans"("courseId", "tenureMonths");

-- CreateIndex
CREATE INDEX "course_addons_tenantId_courseId_idx" ON "course_addons"("tenantId", "courseId");

-- CreateIndex
CREATE INDEX "cohorts_tenantId_trainerPartyId_idx" ON "cohorts"("tenantId", "trainerPartyId");

-- CreateIndex
CREATE UNIQUE INDEX "cohorts_tenantId_recordCode_key" ON "cohorts"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "enrollments_tenantId_cohortId_status_idx" ON "enrollments"("tenantId", "cohortId", "status");

-- CreateIndex
CREATE INDEX "enrollments_tenantId_personId_idx" ON "enrollments"("tenantId", "personId");

-- CreateIndex
CREATE INDEX "enrollments_tenantId_institutionId_idx" ON "enrollments"("tenantId", "institutionId");

-- CreateIndex
CREATE UNIQUE INDEX "enrollments_tenantId_recordCode_key" ON "enrollments"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "attendances_tenantId_sessionDate_idx" ON "attendances"("tenantId", "sessionDate");

-- CreateIndex
CREATE UNIQUE INDEX "attendances_enrollmentId_sessionDate_key" ON "attendances"("enrollmentId", "sessionDate");

-- CreateIndex
CREATE INDEX "daily_progresses_tenantId_enrollmentId_progressDate_idx" ON "daily_progresses"("tenantId", "enrollmentId", "progressDate");

-- CreateIndex
CREATE INDEX "learner_logs_tenantId_enrollmentId_entryDate_idx" ON "learner_logs"("tenantId", "enrollmentId", "entryDate");

-- CreateIndex
CREATE INDEX "learner_logs_tenantId_kind_status_idx" ON "learner_logs"("tenantId", "kind", "status");

-- CreateIndex
CREATE INDEX "projects_tenantId_status_idx" ON "projects"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "projects_tenantId_recordCode_key" ON "projects"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "exception_records_tenantId_state_severity_raisedAt_idx" ON "exception_records"("tenantId", "state", "severity", "raisedAt");

-- CreateIndex
CREATE INDEX "exception_records_tenantId_ownerPartyId_state_idx" ON "exception_records"("tenantId", "ownerPartyId", "state");

-- CreateIndex
CREATE INDEX "exception_records_tenantId_subjectType_subjectId_idx" ON "exception_records"("tenantId", "subjectType", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "exception_records_tenantId_recordCode_key" ON "exception_records"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "notifications_tenantId_recipientPartyId_readAt_idx" ON "notifications"("tenantId", "recipientPartyId", "readAt");

-- CreateIndex
CREATE INDEX "notifications_tenantId_createdAt_idx" ON "notifications"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "automation_definitions_tenantId_jobName_key" ON "automation_definitions"("tenantId", "jobName");

-- CreateIndex
CREATE INDEX "job_runs_tenantId_jobName_startedAt_idx" ON "job_runs"("tenantId", "jobName", "startedAt");

-- CreateIndex
CREATE INDEX "job_firing_logs_tenantId_firedAt_idx" ON "job_firing_logs"("tenantId", "firedAt");

-- CreateIndex
CREATE UNIQUE INDEX "job_firing_logs_automationVersionId_subjectRef_triggerFinge_key" ON "job_firing_logs"("automationVersionId", "subjectRef", "triggerFingerprint", "ladderRung");

-- CreateIndex
CREATE UNIQUE INDEX "agent_principals_tenantId_agentKey_key" ON "agent_principals"("tenantId", "agentKey");

-- CreateIndex
CREATE INDEX "agent_actions_tenantId_agentId_proposedAt_idx" ON "agent_actions"("tenantId", "agentId", "proposedAt");

-- CreateIndex
CREATE INDEX "agent_actions_tenantId_state_idx" ON "agent_actions"("tenantId", "state");

-- CreateIndex
CREATE INDEX "kpi_readings_tenantId_domainCode_metric_asOf_idx" ON "kpi_readings"("tenantId", "domainCode", "metric", "asOf");

-- CreateIndex
CREATE INDEX "health_scores_tenantId_domainCode_asOf_idx" ON "health_scores"("tenantId", "domainCode", "asOf");

-- CreateIndex
CREATE UNIQUE INDEX "health_scores_tenantId_domainCode_asOf_key" ON "health_scores"("tenantId", "domainCode", "asOf");

-- CreateIndex
CREATE INDEX "daily_metrics_tenantId_date_metric_idx" ON "daily_metrics"("tenantId", "date", "metric");

-- CreateIndex
CREATE INDEX "lessons_tenantId_domain_createdAt_idx" ON "lessons"("tenantId", "domain", "createdAt");

-- CreateIndex
CREATE INDEX "narratives_tenantId_forUserId_createdAt_idx" ON "narratives"("tenantId", "forUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "surface_templates_tenantId_templateKey_key" ON "surface_templates"("tenantId", "templateKey");

-- CreateIndex
CREATE UNIQUE INDEX "widget_definitions_tenantId_widgetKey_key" ON "widget_definitions"("tenantId", "widgetKey");

-- CreateIndex
CREATE INDEX "widget_bindings_tenantId_templateId_position_idx" ON "widget_bindings"("tenantId", "templateId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "widget_bindings_templateId_widgetId_key" ON "widget_bindings"("templateId", "widgetId");

-- CreateIndex
CREATE INDEX "nav_nodes_tenantId_group_position_idx" ON "nav_nodes"("tenantId", "group", "position");

-- CreateIndex
CREATE UNIQUE INDEX "nav_nodes_tenantId_nodeKey_key" ON "nav_nodes"("tenantId", "nodeKey");

-- CreateIndex
CREATE INDEX "surface_compositions_tenantId_userId_composedAt_idx" ON "surface_compositions"("tenantId", "userId", "composedAt");

-- CreateIndex
CREATE UNIQUE INDEX "thresholds_tenantId_thresholdKey_key" ON "thresholds"("tenantId", "thresholdKey");

-- CreateIndex
CREATE INDEX "org_units_tenantId_parentId_idx" ON "org_units"("tenantId", "parentId");

-- CreateIndex
CREATE INDEX "jobs_tenantId_jobFamily_idx" ON "jobs"("tenantId", "jobFamily");

-- CreateIndex
CREATE INDEX "positions_tenantId_status_idx" ON "positions"("tenantId", "status");

-- CreateIndex
CREATE INDEX "positions_tenantId_orgUnitId_idx" ON "positions"("tenantId", "orgUnitId");

-- CreateIndex
CREATE UNIQUE INDEX "positions_tenantId_recordCode_key" ON "positions"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "employment_relationships_tenantId_status_idx" ON "employment_relationships"("tenantId", "status");

-- CreateIndex
CREATE INDEX "employment_relationships_tenantId_personId_idx" ON "employment_relationships"("tenantId", "personId");

-- CreateIndex
CREATE UNIQUE INDEX "employment_relationships_tenantId_recordCode_key" ON "employment_relationships"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "requisitions_tenantId_status_idx" ON "requisitions"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "requisitions_tenantId_recordCode_key" ON "requisitions"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "applications_tenantId_status_idx" ON "applications"("tenantId", "status");

-- CreateIndex
CREATE INDEX "applications_tenantId_requisitionId_idx" ON "applications"("tenantId", "requisitionId");

-- CreateIndex
CREATE UNIQUE INDEX "applications_tenantId_recordCode_key" ON "applications"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "assignments_tenantId_employmentRelationshipId_rowStatus_idx" ON "assignments"("tenantId", "employmentRelationshipId", "rowStatus");

-- CreateIndex
CREATE INDEX "assignments_tenantId_positionId_idx" ON "assignments"("tenantId", "positionId");

-- CreateIndex
CREATE INDEX "compensation_records_tenantId_employmentRelationshipId_stat_idx" ON "compensation_records"("tenantId", "employmentRelationshipId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "leave_types_tenantId_code_key" ON "leave_types"("tenantId", "code");

-- CreateIndex
CREATE INDEX "leave_balances_tenantId_idx" ON "leave_balances"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "leave_balances_employmentRelationshipId_leaveTypeId_key" ON "leave_balances"("employmentRelationshipId", "leaveTypeId");

-- CreateIndex
CREATE INDEX "leave_transactions_tenantId_leaveBalanceId_createdAt_idx" ON "leave_transactions"("tenantId", "leaveBalanceId", "createdAt");

-- CreateIndex
CREATE INDEX "leave_requests_tenantId_status_idx" ON "leave_requests"("tenantId", "status");

-- CreateIndex
CREATE INDEX "leave_requests_tenantId_employmentRelationshipId_startDate_idx" ON "leave_requests"("tenantId", "employmentRelationshipId", "startDate");

-- CreateIndex
CREATE UNIQUE INDEX "leave_requests_tenantId_recordCode_key" ON "leave_requests"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "work_attendances_tenantId_workDate_idx" ON "work_attendances"("tenantId", "workDate");

-- CreateIndex
CREATE UNIQUE INDEX "work_attendances_employmentRelationshipId_workDate_key" ON "work_attendances"("employmentRelationshipId", "workDate");

-- CreateIndex
CREATE INDEX "goals_tenantId_employmentRelationshipId_status_idx" ON "goals"("tenantId", "employmentRelationshipId", "status");

-- CreateIndex
CREATE INDEX "performance_evidence_tenantId_employmentRelationshipId_crea_idx" ON "performance_evidence"("tenantId", "employmentRelationshipId", "createdAt");

-- CreateIndex
CREATE INDEX "performance_evidence_tenantId_caseScoped_idx" ON "performance_evidence"("tenantId", "caseScoped");

-- CreateIndex
CREATE INDEX "learning_activities_tenantId_idx" ON "learning_activities"("tenantId");

-- CreateIndex
CREATE INDEX "learning_records_tenantId_employmentRelationshipId_idx" ON "learning_records"("tenantId", "employmentRelationshipId");

-- CreateIndex
CREATE UNIQUE INDEX "skills_tenantId_name_key" ON "skills"("tenantId", "name");

-- CreateIndex
CREATE INDEX "capability_evidence_tenantId_capabilityClaimId_idx" ON "capability_evidence"("tenantId", "capabilityClaimId");

-- CreateIndex
CREATE INDEX "verification_events_tenantId_capabilityClaimId_idx" ON "verification_events"("tenantId", "capabilityClaimId");

-- CreateIndex
CREATE INDEX "payroll_instructions_tenantId_payPeriod_status_idx" ON "payroll_instructions"("tenantId", "payPeriod", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_instructions_employmentRelationshipId_payPeriod_key" ON "payroll_instructions"("employmentRelationshipId", "payPeriod");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_tenantId_recordCode_key" ON "payroll_runs"("tenantId", "recordCode");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_tenantId_payPeriod_key" ON "payroll_runs"("tenantId", "payPeriod");

-- CreateIndex
CREATE UNIQUE INDEX "onboardings_employmentRelationshipId_key" ON "onboardings"("employmentRelationshipId");

-- CreateIndex
CREATE INDEX "onboardings_tenantId_status_idx" ON "onboardings"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "offboardings_employmentRelationshipId_key" ON "offboardings"("employmentRelationshipId");

-- CreateIndex
CREATE INDEX "offboardings_tenantId_status_idx" ON "offboardings"("tenantId", "status");

-- CreateIndex
CREATE INDEX "ledger_accounts_tenantId_active_idx" ON "ledger_accounts"("tenantId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_tenantId_name_key" ON "ledger_accounts"("tenantId", "name");

-- CreateIndex
CREATE INDEX "ledger_categories_tenantId_kind_idx" ON "ledger_categories"("tenantId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_categories_tenantId_name_key" ON "ledger_categories"("tenantId", "name");

-- CreateIndex
CREATE INDEX "transactions_tenantId_txnDate_idx" ON "transactions"("tenantId", "txnDate");

-- CreateIndex
CREATE INDEX "transactions_tenantId_categoryId_txnDate_idx" ON "transactions"("tenantId", "categoryId", "txnDate");

-- CreateIndex
CREATE INDEX "transactions_tenantId_division_txnDate_idx" ON "transactions"("tenantId", "division", "txnDate");

-- CreateIndex
CREATE INDEX "transactions_tenantId_accountId_txnDate_idx" ON "transactions"("tenantId", "accountId", "txnDate");

-- CreateIndex
CREATE INDEX "transactions_tenantId_source_idx" ON "transactions"("tenantId", "source");

-- CreateIndex
CREATE INDEX "transactions_tenantId_intercompanyTenantId_idx" ON "transactions"("tenantId", "intercompanyTenantId");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_tenantId_recordCode_key" ON "transactions"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "vendor_bills_tenantId_status_dueDate_idx" ON "vendor_bills"("tenantId", "status", "dueDate");

-- CreateIndex
CREATE INDEX "vendor_bills_tenantId_vendorName_idx" ON "vendor_bills"("tenantId", "vendorName");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_bills_tenantId_recordCode_key" ON "vendor_bills"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "budget_lines_tenantId_period_idx" ON "budget_lines"("tenantId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "budget_lines_tenantId_period_categoryId_division_key" ON "budget_lines"("tenantId", "period", "categoryId", "division");

-- CreateIndex
CREATE INDEX "recurring_rules_tenantId_active_idx" ON "recurring_rules"("tenantId", "active");

-- CreateIndex
CREATE INDEX "fixed_assets_tenantId_disposedAt_idx" ON "fixed_assets"("tenantId", "disposedAt");

-- CreateIndex
CREATE UNIQUE INDEX "fixed_assets_tenantId_recordCode_key" ON "fixed_assets"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "loans_tenantId_closedAt_idx" ON "loans"("tenantId", "closedAt");

-- CreateIndex
CREATE UNIQUE INDEX "loans_tenantId_recordCode_key" ON "loans"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "import_batches_tenantId_status_idx" ON "import_batches"("tenantId", "status");

-- CreateIndex
CREATE INDEX "import_batches_tenantId_contentHash_idx" ON "import_batches"("tenantId", "contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "import_batches_tenantId_recordCode_key" ON "import_batches"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "import_rows_tenantId_batchId_rowNumber_idx" ON "import_rows"("tenantId", "batchId", "rowNumber");

-- CreateIndex
CREATE INDEX "import_rows_tenantId_dedupeKey_idx" ON "import_rows"("tenantId", "dedupeKey");

-- CreateIndex
CREATE INDEX "import_rows_batchId_status_idx" ON "import_rows"("batchId", "status");

-- CreateIndex
CREATE INDEX "board_members_tenantId_status_idx" ON "board_members"("tenantId", "status");

-- CreateIndex
CREATE INDEX "board_members_tenantId_personId_idx" ON "board_members"("tenantId", "personId");

-- CreateIndex
CREATE UNIQUE INDEX "board_members_tenantId_recordCode_key" ON "board_members"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "board_meetings_tenantId_status_idx" ON "board_meetings"("tenantId", "status");

-- CreateIndex
CREATE INDEX "board_meetings_tenantId_scheduledFor_idx" ON "board_meetings"("tenantId", "scheduledFor");

-- CreateIndex
CREATE INDEX "board_meetings_tenantId_heldOn_idx" ON "board_meetings"("tenantId", "heldOn");

-- CreateIndex
CREATE UNIQUE INDEX "board_meetings_tenantId_recordCode_key" ON "board_meetings"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "resolutions_tenantId_outcome_idx" ON "resolutions"("tenantId", "outcome");

-- CreateIndex
CREATE INDEX "resolutions_tenantId_meetingId_idx" ON "resolutions"("tenantId", "meetingId");

-- CreateIndex
CREATE UNIQUE INDEX "resolutions_tenantId_recordCode_key" ON "resolutions"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "votes_tenantId_resolutionId_idx" ON "votes"("tenantId", "resolutionId");

-- CreateIndex
CREATE UNIQUE INDEX "votes_resolutionId_boardMemberId_key" ON "votes"("resolutionId", "boardMemberId");

-- CreateIndex
CREATE INDEX "compliance_items_tenantId_status_dueOn_idx" ON "compliance_items"("tenantId", "status", "dueOn");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_items_tenantId_kind_relatedType_relatedId_dueOn_key" ON "compliance_items"("tenantId", "kind", "relatedType", "relatedId", "dueOn");

-- CreateIndex
CREATE INDEX "board_pack_items_tenantId_meetingId_order_idx" ON "board_pack_items"("tenantId", "meetingId", "order");

-- CreateIndex
CREATE INDEX "mkt_campaigns_tenantId_status_idx" ON "mkt_campaigns"("tenantId", "status");

-- CreateIndex
CREATE INDEX "mkt_campaigns_tenantId_division_idx" ON "mkt_campaigns"("tenantId", "division");

-- CreateIndex
CREATE INDEX "mkt_campaigns_tenantId_startAt_idx" ON "mkt_campaigns"("tenantId", "startAt");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_campaigns_tenantId_recordCode_key" ON "mkt_campaigns"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "mkt_campaign_approvals_tenantId_campaignId_idx" ON "mkt_campaign_approvals"("tenantId", "campaignId");

-- CreateIndex
CREATE INDEX "mkt_campaign_approvals_tenantId_decision_idx" ON "mkt_campaign_approvals"("tenantId", "decision");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_campaign_approvals_tenantId_recordCode_key" ON "mkt_campaign_approvals"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "mkt_channels_tenantId_active_idx" ON "mkt_channels"("tenantId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_channels_tenantId_recordCode_key" ON "mkt_channels"("tenantId", "recordCode");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_channels_tenantId_key_key" ON "mkt_channels"("tenantId", "key");

-- CreateIndex
CREATE INDEX "mkt_audiences_tenantId_kind_idx" ON "mkt_audiences"("tenantId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_audiences_tenantId_recordCode_key" ON "mkt_audiences"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "mkt_audience_members_tenantId_audienceId_idx" ON "mkt_audience_members"("tenantId", "audienceId");

-- CreateIndex
CREATE INDEX "mkt_audience_members_tenantId_entityType_entityId_idx" ON "mkt_audience_members"("tenantId", "entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_audience_members_tenantId_recordCode_key" ON "mkt_audience_members"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "mkt_preferences_tenantId_personId_idx" ON "mkt_preferences"("tenantId", "personId");

-- CreateIndex
CREATE INDEX "mkt_preferences_tenantId_channelKey_idx" ON "mkt_preferences"("tenantId", "channelKey");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_preferences_tenantId_recordCode_key" ON "mkt_preferences"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "mkt_templates_tenantId_channelKey_idx" ON "mkt_templates"("tenantId", "channelKey");

-- CreateIndex
CREATE INDEX "mkt_templates_tenantId_status_idx" ON "mkt_templates"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_templates_tenantId_recordCode_key" ON "mkt_templates"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "mkt_sends_tenantId_status_idx" ON "mkt_sends"("tenantId", "status");

-- CreateIndex
CREATE INDEX "mkt_sends_tenantId_campaignId_idx" ON "mkt_sends"("tenantId", "campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_sends_tenantId_recordCode_key" ON "mkt_sends"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "mkt_send_recipients_tenantId_sendId_idx" ON "mkt_send_recipients"("tenantId", "sendId");

-- CreateIndex
CREATE INDEX "mkt_send_recipients_tenantId_personId_idx" ON "mkt_send_recipients"("tenantId", "personId");

-- CreateIndex
CREATE INDEX "mkt_send_recipients_tenantId_status_idx" ON "mkt_send_recipients"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_send_recipients_tenantId_recordCode_key" ON "mkt_send_recipients"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "mkt_journeys_tenantId_status_idx" ON "mkt_journeys"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_journeys_tenantId_recordCode_key" ON "mkt_journeys"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "mkt_journey_runs_tenantId_journeyId_idx" ON "mkt_journey_runs"("tenantId", "journeyId");

-- CreateIndex
CREATE INDEX "mkt_journey_runs_tenantId_personId_idx" ON "mkt_journey_runs"("tenantId", "personId");

-- CreateIndex
CREATE INDEX "mkt_journey_runs_tenantId_status_idx" ON "mkt_journey_runs"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_journey_runs_tenantId_recordCode_key" ON "mkt_journey_runs"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "mkt_forms_tenantId_active_idx" ON "mkt_forms"("tenantId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_forms_tenantId_recordCode_key" ON "mkt_forms"("tenantId", "recordCode");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_forms_tenantId_slug_key" ON "mkt_forms"("tenantId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_forms_tenantId_publicToken_key" ON "mkt_forms"("tenantId", "publicToken");

-- CreateIndex
CREATE INDEX "mkt_form_submissions_tenantId_formId_idx" ON "mkt_form_submissions"("tenantId", "formId");

-- CreateIndex
CREATE INDEX "mkt_form_submissions_tenantId_status_idx" ON "mkt_form_submissions"("tenantId", "status");

-- CreateIndex
CREATE INDEX "mkt_form_submissions_tenantId_receivedAt_idx" ON "mkt_form_submissions"("tenantId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_form_submissions_tenantId_recordCode_key" ON "mkt_form_submissions"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "mkt_touchpoints_tenantId_personId_idx" ON "mkt_touchpoints"("tenantId", "personId");

-- CreateIndex
CREATE INDEX "mkt_touchpoints_tenantId_campaignId_idx" ON "mkt_touchpoints"("tenantId", "campaignId");

-- CreateIndex
CREATE INDEX "mkt_touchpoints_tenantId_occurredAt_idx" ON "mkt_touchpoints"("tenantId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_touchpoints_tenantId_recordCode_key" ON "mkt_touchpoints"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "mkt_attributions_tenantId_leadId_idx" ON "mkt_attributions"("tenantId", "leadId");

-- CreateIndex
CREATE INDEX "mkt_attributions_tenantId_campaignId_idx" ON "mkt_attributions"("tenantId", "campaignId");

-- CreateIndex
CREATE INDEX "mkt_attributions_tenantId_computedAt_idx" ON "mkt_attributions"("tenantId", "computedAt");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_attributions_tenantId_recordCode_key" ON "mkt_attributions"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "mkt_lead_score_rules_tenantId_active_idx" ON "mkt_lead_score_rules"("tenantId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_lead_score_rules_tenantId_recordCode_key" ON "mkt_lead_score_rules"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "mkt_events_tenantId_status_idx" ON "mkt_events"("tenantId", "status");

-- CreateIndex
CREATE INDEX "mkt_events_tenantId_startAt_idx" ON "mkt_events"("tenantId", "startAt");

-- CreateIndex
CREATE INDEX "mkt_events_tenantId_campaignId_idx" ON "mkt_events"("tenantId", "campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_events_tenantId_recordCode_key" ON "mkt_events"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "mkt_event_registrations_tenantId_eventId_idx" ON "mkt_event_registrations"("tenantId", "eventId");

-- CreateIndex
CREATE INDEX "mkt_event_registrations_tenantId_personId_idx" ON "mkt_event_registrations"("tenantId", "personId");

-- CreateIndex
CREATE INDEX "mkt_event_registrations_tenantId_status_idx" ON "mkt_event_registrations"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_event_registrations_tenantId_recordCode_key" ON "mkt_event_registrations"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "mkt_assets_tenantId_status_idx" ON "mkt_assets"("tenantId", "status");

-- CreateIndex
CREATE INDEX "mkt_assets_tenantId_campaignId_idx" ON "mkt_assets"("tenantId", "campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_assets_tenantId_recordCode_key" ON "mkt_assets"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "mkt_social_posts_tenantId_status_idx" ON "mkt_social_posts"("tenantId", "status");

-- CreateIndex
CREATE INDEX "mkt_social_posts_tenantId_campaignId_idx" ON "mkt_social_posts"("tenantId", "campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_social_posts_tenantId_recordCode_key" ON "mkt_social_posts"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "mkt_short_links_tenantId_campaignId_idx" ON "mkt_short_links"("tenantId", "campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_short_links_tenantId_recordCode_key" ON "mkt_short_links"("tenantId", "recordCode");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_short_links_tenantId_slug_key" ON "mkt_short_links"("tenantId", "slug");

-- CreateIndex
CREATE INDEX "mkt_referral_programs_tenantId_active_idx" ON "mkt_referral_programs"("tenantId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_referral_programs_tenantId_recordCode_key" ON "mkt_referral_programs"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "mkt_referrals_tenantId_programId_idx" ON "mkt_referrals"("tenantId", "programId");

-- CreateIndex
CREATE INDEX "mkt_referrals_tenantId_status_idx" ON "mkt_referrals"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_referrals_tenantId_recordCode_key" ON "mkt_referrals"("tenantId", "recordCode");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_referrals_tenantId_code_key" ON "mkt_referrals"("tenantId", "code");

-- CreateIndex
CREATE INDEX "mkt_budgets_tenantId_period_idx" ON "mkt_budgets"("tenantId", "period");

-- CreateIndex
CREATE INDEX "mkt_budgets_tenantId_division_idx" ON "mkt_budgets"("tenantId", "division");

-- CreateIndex
CREATE INDEX "mkt_budgets_tenantId_campaignId_idx" ON "mkt_budgets"("tenantId", "campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_budgets_tenantId_recordCode_key" ON "mkt_budgets"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "mkt_spends_tenantId_campaignId_idx" ON "mkt_spends"("tenantId", "campaignId");

-- CreateIndex
CREATE INDEX "mkt_spends_tenantId_spendDate_idx" ON "mkt_spends"("tenantId", "spendDate");

-- CreateIndex
CREATE INDEX "mkt_spends_tenantId_status_idx" ON "mkt_spends"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_spends_tenantId_recordCode_key" ON "mkt_spends"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "mkt_vendors_tenantId_organizationId_idx" ON "mkt_vendors"("tenantId", "organizationId");

-- CreateIndex
CREATE INDEX "mkt_vendors_tenantId_active_idx" ON "mkt_vendors"("tenantId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_vendors_tenantId_recordCode_key" ON "mkt_vendors"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "mkt_claims_tenantId_status_idx" ON "mkt_claims"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_claims_tenantId_recordCode_key" ON "mkt_claims"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "mkt_plans_tenantId_period_idx" ON "mkt_plans"("tenantId", "period");

-- CreateIndex
CREATE INDEX "mkt_plans_tenantId_division_idx" ON "mkt_plans"("tenantId", "division");

-- CreateIndex
CREATE INDEX "mkt_plans_tenantId_status_idx" ON "mkt_plans"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_plans_tenantId_recordCode_key" ON "mkt_plans"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "mkt_webhooks_inbound_tenantId_provider_idx" ON "mkt_webhooks_inbound"("tenantId", "provider");

-- CreateIndex
CREATE INDEX "mkt_webhooks_inbound_tenantId_status_idx" ON "mkt_webhooks_inbound"("tenantId", "status");

-- CreateIndex
CREATE INDEX "mkt_webhooks_inbound_tenantId_receivedAt_idx" ON "mkt_webhooks_inbound"("tenantId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_webhooks_inbound_tenantId_recordCode_key" ON "mkt_webhooks_inbound"("tenantId", "recordCode");

-- AddForeignKey
ALTER TABLE "cmp_accounting_periods" ADD CONSTRAINT "cmp_accounting_periods_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "ledger_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "ledger_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "cmp_accounting_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_obligations" ADD CONSTRAINT "compliance_obligations_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "compliance_obligation_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_board_resolutions" ADD CONSTRAINT "compliance_board_resolutions_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "compliance_board_meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hcm_assets_asset_assignments" ADD CONSTRAINT "hcm_assets_asset_assignments_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "hcm_assets_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hcm_engagement_announcement_acks" ADD CONSTRAINT "hcm_engagement_announcement_acks_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "hcm_engagement_announcements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hcm_engagement_survey_responses" ADD CONSTRAINT "hcm_engagement_survey_responses_surveyId_fkey" FOREIGN KEY ("surveyId") REFERENCES "hcm_engagement_pulse_surveys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hcm_engagement_hr_case_messages" ADD CONSTRAINT "hcm_engagement_hr_case_messages_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "hcm_engagement_hr_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hcm_engagement_policy_acknowledgements" ADD CONSTRAINT "hcm_engagement_policy_acknowledgements_policyDocumentId_fkey" FOREIGN KEY ("policyDocumentId") REFERENCES "hcm_engagement_policy_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hcm_learning_training_sessions" ADD CONSTRAINT "hcm_learning_training_sessions_programId_fkey" FOREIGN KEY ("programId") REFERENCES "hcm_learning_training_programs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hcm_learning_training_enrollments" ADD CONSTRAINT "hcm_learning_training_enrollments_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "hcm_learning_training_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hcm_learning_mandatory_training_rules" ADD CONSTRAINT "hcm_learning_mandatory_training_rules_programId_fkey" FOREIGN KEY ("programId") REFERENCES "hcm_learning_training_programs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hcm_leavepolicy_rules" ADD CONSTRAINT "hcm_leavepolicy_rules_leavePolicyId_fkey" FOREIGN KEY ("leavePolicyId") REFERENCES "hcm_leavepolicy_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hcm_leavepolicy_accrual_runs" ADD CONSTRAINT "hcm_leavepolicy_accrual_runs_leavePolicyRuleId_fkey" FOREIGN KEY ("leavePolicyRuleId") REFERENCES "hcm_leavepolicy_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hcm_leavepolicy_request_approvals" ADD CONSTRAINT "hcm_leavepolicy_request_approvals_chainId_fkey" FOREIGN KEY ("chainId") REFERENCES "hcm_leavepolicy_approval_chains"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hcm_workflow_requests" ADD CONSTRAINT "hcm_workflow_requests_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "hcm_workflow_request_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hcm_workflow_request_approvals" ADD CONSTRAINT "hcm_workflow_request_approvals_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "hcm_workflow_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "it_asset_assignments" ADD CONSTRAINT "it_asset_assignments_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "it_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "it_asset_events" ADD CONSTRAINT "it_asset_events_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "it_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "it_continuity_tests" ADD CONSTRAINT "it_continuity_tests_planId_fkey" FOREIGN KEY ("planId") REFERENCES "it_continuity_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "it_policy_acknowledgements" ADD CONSTRAINT "it_policy_acknowledgements_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "it_policy_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "it_control_tests" ADD CONSTRAINT "it_control_tests_controlId_fkey" FOREIGN KEY ("controlId") REFERENCES "it_controls"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "it_access_review_items" ADD CONSTRAINT "it_access_review_items_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "it_access_reviews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "it_incident_updates" ADD CONSTRAINT "it_incident_updates_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "it_incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "it_initiative_updates" ADD CONSTRAINT "it_initiative_updates_initiativeId_fkey" FOREIGN KEY ("initiativeId") REFERENCES "it_initiatives"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "it_ticket_comments" ADD CONSTRAINT "it_ticket_comments_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "it_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "it_licences" ADD CONSTRAINT "it_licences_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "it_applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "it_licence_events" ADD CONSTRAINT "it_licence_events_licenceId_fkey" FOREIGN KEY ("licenceId") REFERENCES "it_licences"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "it_vendor_risk_assessments" ADD CONSTRAINT "it_vendor_risk_assessments_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "it_vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "it_vendor_contracts" ADD CONSTRAINT "it_vendor_contracts_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "it_vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_parentTenantId_fkey" FOREIGN KEY ("parentTenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "record_sequences" ADD CONSTRAINT "record_sequences_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "people" ADD CONSTRAINT "people_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "people" ADD CONSTRAINT "people_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliations" ADD CONSTRAINT "affiliations_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "people"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_parentOrgId_fkey" FOREIGN KEY ("parentOrgId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institution_profiles" ADD CONSTRAINT "institution_profiles_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_personId_fkey" FOREIGN KEY ("personId") REFERENCES "people"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_sponsorId_fkey" FOREIGN KEY ("sponsorId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grants" ADD CONSTRAINT "grants_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "access_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grants" ADD CONSTRAINT "grants_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "policy_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "decisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_records" ADD CONSTRAINT "event_records_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_personId_fkey" FOREIGN KEY ("personId") REFERENCES "people"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "principals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "pipeline_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_transitions" ADD CONSTRAINT "pipeline_transitions_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "pipeline_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capability_claims" ADD CONSTRAINT "capability_claims_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "skills"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_personId_fkey" FOREIGN KEY ("personId") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "offerings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "pipeline_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_territoryId_fkey" FOREIGN KEY ("territoryId") REFERENCES "territories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "mkt_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "offerings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "pipeline_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_book_entries" ADD CONSTRAINT "price_book_entries_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "offerings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_priceBookEntryId_fkey" FOREIGN KEY ("priceBookEntryId") REFERENCES "price_book_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "share_transactions" ADD CONSTRAINT "share_transactions_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "funding_rounds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_feeInstalmentId_fkey" FOREIGN KEY ("feeInstalmentId") REFERENCES "fee_instalments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "final_invoices" ADD CONSTRAINT "final_invoices_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_fee_plans" ADD CONSTRAINT "course_fee_plans_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_addons" ADD CONSTRAINT "course_addons_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cohorts" ADD CONSTRAINT "cohorts_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "cohorts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendances" ADD CONSTRAINT "attendances_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "enrollments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_progresses" ADD CONSTRAINT "daily_progresses_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "enrollments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learner_logs" ADD CONSTRAINT "learner_logs_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "enrollments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "automation_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent_principals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "widget_bindings" ADD CONSTRAINT "widget_bindings_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "surface_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "widget_bindings" ADD CONSTRAINT "widget_bindings_widgetId_fkey" FOREIGN KEY ("widgetId") REFERENCES "widget_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_units" ADD CONSTRAINT "org_units_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "org_units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_orgUnitId_fkey" FOREIGN KEY ("orgUnitId") REFERENCES "org_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employment_relationships" ADD CONSTRAINT "employment_relationships_personId_fkey" FOREIGN KEY ("personId") REFERENCES "people"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_requisitionId_fkey" FOREIGN KEY ("requisitionId") REFERENCES "requisitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_candidatePartyId_fkey" FOREIGN KEY ("candidatePartyId") REFERENCES "people"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_employmentRelationshipId_fkey" FOREIGN KEY ("employmentRelationshipId") REFERENCES "employment_relationships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compensation_records" ADD CONSTRAINT "compensation_records_employmentRelationshipId_fkey" FOREIGN KEY ("employmentRelationshipId") REFERENCES "employment_relationships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compensation_records" ADD CONSTRAINT "compensation_records_linkedAssignmentId_fkey" FOREIGN KEY ("linkedAssignmentId") REFERENCES "assignments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_employmentRelationshipId_fkey" FOREIGN KEY ("employmentRelationshipId") REFERENCES "employment_relationships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "leave_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_transactions" ADD CONSTRAINT "leave_transactions_leaveBalanceId_fkey" FOREIGN KEY ("leaveBalanceId") REFERENCES "leave_balances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_employmentRelationshipId_fkey" FOREIGN KEY ("employmentRelationshipId") REFERENCES "employment_relationships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "leave_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_attendances" ADD CONSTRAINT "work_attendances_employmentRelationshipId_fkey" FOREIGN KEY ("employmentRelationshipId") REFERENCES "employment_relationships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goals" ADD CONSTRAINT "goals_employmentRelationshipId_fkey" FOREIGN KEY ("employmentRelationshipId") REFERENCES "employment_relationships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_evidence" ADD CONSTRAINT "performance_evidence_employmentRelationshipId_fkey" FOREIGN KEY ("employmentRelationshipId") REFERENCES "employment_relationships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_records" ADD CONSTRAINT "learning_records_employmentRelationshipId_fkey" FOREIGN KEY ("employmentRelationshipId") REFERENCES "employment_relationships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_records" ADD CONSTRAINT "learning_records_learningActivityId_fkey" FOREIGN KEY ("learningActivityId") REFERENCES "learning_activities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capability_evidence" ADD CONSTRAINT "capability_evidence_capabilityClaimId_fkey" FOREIGN KEY ("capabilityClaimId") REFERENCES "capability_claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_events" ADD CONSTRAINT "verification_events_capabilityClaimId_fkey" FOREIGN KEY ("capabilityClaimId") REFERENCES "capability_claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_instructions" ADD CONSTRAINT "payroll_instructions_employmentRelationshipId_fkey" FOREIGN KEY ("employmentRelationshipId") REFERENCES "employment_relationships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_instructions" ADD CONSTRAINT "payroll_instructions_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "payroll_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboardings" ADD CONSTRAINT "onboardings_employmentRelationshipId_fkey" FOREIGN KEY ("employmentRelationshipId") REFERENCES "employment_relationships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offboardings" ADD CONSTRAINT "offboardings_employmentRelationshipId_fkey" FOREIGN KEY ("employmentRelationshipId") REFERENCES "employment_relationships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ledger_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_categories" ADD CONSTRAINT "ledger_categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ledger_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ledger_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ledger_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_rules" ADD CONSTRAINT "recurring_rules_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ledger_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "import_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_campaigns" ADD CONSTRAINT "mkt_campaigns_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "offerings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_campaigns" ADD CONSTRAINT "mkt_campaigns_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_campaigns" ADD CONSTRAINT "mkt_campaigns_audienceId_fkey" FOREIGN KEY ("audienceId") REFERENCES "mkt_audiences"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_campaign_approvals" ADD CONSTRAINT "mkt_campaign_approvals_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "mkt_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_audience_members" ADD CONSTRAINT "mkt_audience_members_audienceId_fkey" FOREIGN KEY ("audienceId") REFERENCES "mkt_audiences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_preferences" ADD CONSTRAINT "mkt_preferences_personId_fkey" FOREIGN KEY ("personId") REFERENCES "people"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_sends" ADD CONSTRAINT "mkt_sends_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "mkt_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_sends" ADD CONSTRAINT "mkt_sends_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "mkt_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_sends" ADD CONSTRAINT "mkt_sends_audienceId_fkey" FOREIGN KEY ("audienceId") REFERENCES "mkt_audiences"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_send_recipients" ADD CONSTRAINT "mkt_send_recipients_sendId_fkey" FOREIGN KEY ("sendId") REFERENCES "mkt_sends"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_send_recipients" ADD CONSTRAINT "mkt_send_recipients_personId_fkey" FOREIGN KEY ("personId") REFERENCES "people"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_journey_runs" ADD CONSTRAINT "mkt_journey_runs_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "mkt_journeys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_journey_runs" ADD CONSTRAINT "mkt_journey_runs_personId_fkey" FOREIGN KEY ("personId") REFERENCES "people"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_forms" ADD CONSTRAINT "mkt_forms_defaultCampaignId_fkey" FOREIGN KEY ("defaultCampaignId") REFERENCES "mkt_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_form_submissions" ADD CONSTRAINT "mkt_form_submissions_formId_fkey" FOREIGN KEY ("formId") REFERENCES "mkt_forms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_form_submissions" ADD CONSTRAINT "mkt_form_submissions_personId_fkey" FOREIGN KEY ("personId") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_form_submissions" ADD CONSTRAINT "mkt_form_submissions_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_touchpoints" ADD CONSTRAINT "mkt_touchpoints_personId_fkey" FOREIGN KEY ("personId") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_touchpoints" ADD CONSTRAINT "mkt_touchpoints_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_touchpoints" ADD CONSTRAINT "mkt_touchpoints_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_touchpoints" ADD CONSTRAINT "mkt_touchpoints_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "mkt_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_attributions" ADD CONSTRAINT "mkt_attributions_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_attributions" ADD CONSTRAINT "mkt_attributions_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_attributions" ADD CONSTRAINT "mkt_attributions_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "enrollments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_attributions" ADD CONSTRAINT "mkt_attributions_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "mkt_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_events" ADD CONSTRAINT "mkt_events_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "mkt_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_events" ADD CONSTRAINT "mkt_events_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_event_registrations" ADD CONSTRAINT "mkt_event_registrations_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "mkt_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_event_registrations" ADD CONSTRAINT "mkt_event_registrations_personId_fkey" FOREIGN KEY ("personId") REFERENCES "people"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_event_registrations" ADD CONSTRAINT "mkt_event_registrations_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_assets" ADD CONSTRAINT "mkt_assets_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "mkt_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_social_posts" ADD CONSTRAINT "mkt_social_posts_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "mkt_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_short_links" ADD CONSTRAINT "mkt_short_links_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "mkt_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_referrals" ADD CONSTRAINT "mkt_referrals_programId_fkey" FOREIGN KEY ("programId") REFERENCES "mkt_referral_programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_referrals" ADD CONSTRAINT "mkt_referrals_referrerPersonId_fkey" FOREIGN KEY ("referrerPersonId") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_referrals" ADD CONSTRAINT "mkt_referrals_referrerOrganizationId_fkey" FOREIGN KEY ("referrerOrganizationId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_referrals" ADD CONSTRAINT "mkt_referrals_referredPersonId_fkey" FOREIGN KEY ("referredPersonId") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_referrals" ADD CONSTRAINT "mkt_referrals_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_budgets" ADD CONSTRAINT "mkt_budgets_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "mkt_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_spends" ADD CONSTRAINT "mkt_spends_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "mkt_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_spends" ADD CONSTRAINT "mkt_spends_vendorOrganizationId_fkey" FOREIGN KEY ("vendorOrganizationId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mkt_vendors" ADD CONSTRAINT "mkt_vendors_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

