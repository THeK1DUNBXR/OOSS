-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

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
    "source" TEXT NOT NULL DEFAULT 'manual',
    "payrollRunId" TEXT,
    "invoiceId" TEXT,
    "vendorBillId" TEXT,
    "fixedAssetId" TEXT,
    "loanId" TEXT,
    "reversalOfId" TEXT,
    "reversedById" TEXT,
    "reconciledAt" TIMESTAMP(3),
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
    "gstRate" DECIMAL(5,2) NOT NULL DEFAULT 18,
    "hsnSac" TEXT,
    "division" TEXT NOT NULL DEFAULT 'education',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "courses_pkey" PRIMARY KEY ("id")
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
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "amount" DECIMAL(18,2) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "revenueMethod" TEXT NOT NULL,
    "hsnSac" TEXT,
    "gstRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "offboardings_pkey" PRIMARY KEY ("id")
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_profiles_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "branch" TEXT,
    "activeAffiliationId" TEXT,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',

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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_records" (
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
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_records_pkey" PRIMARY KEY ("id")
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
CREATE INDEX "relationships_tenantId_fromType_fromId_idx" ON "relationships"("tenantId", "fromType", "fromId");

-- CreateIndex
CREATE INDEX "relationships_tenantId_toType_toId_idx" ON "relationships"("tenantId", "toType", "toId");

-- CreateIndex
CREATE INDEX "relationships_tenantId_relationshipType_status_idx" ON "relationships"("tenantId", "relationshipType", "status");

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
CREATE INDEX "projects_tenantId_status_idx" ON "projects"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "projects_tenantId_recordCode_key" ON "projects"("tenantId", "recordCode");

-- CreateIndex
CREATE UNIQUE INDEX "courses_tenantId_recordCode_key" ON "courses"("tenantId", "recordCode");

-- CreateIndex
CREATE UNIQUE INDEX "courses_tenantId_code_key" ON "courses"("tenantId", "code");

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
CREATE INDEX "users_tenantId_personId_idx" ON "users"("tenantId", "personId");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenantId_email_key" ON "users"("tenantId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "attention_watermarks_tenantId_userId_affiliationId_key" ON "attention_watermarks"("tenantId", "userId", "affiliationId");

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
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "record_sequences_tenantId_entityType_year_key" ON "record_sequences"("tenantId", "entityType", "year");

-- CreateIndex
CREATE UNIQUE INDEX "company_profiles_tenantId_key" ON "company_profiles"("tenantId");

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
CREATE INDEX "event_dead_letters_tenantId_state_createdAt_idx" ON "event_dead_letters"("tenantId", "state", "createdAt");

-- CreateIndex
CREATE INDEX "audit_records_tenantId_subjectType_subjectId_timestamp_idx" ON "audit_records"("tenantId", "subjectType", "subjectId", "timestamp");

-- CreateIndex
CREATE INDEX "audit_records_tenantId_actorId_timestamp_idx" ON "audit_records"("tenantId", "actorId", "timestamp");

-- CreateIndex
CREATE INDEX "audit_records_tenantId_timestamp_idx" ON "audit_records"("tenantId", "timestamp");

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
ALTER TABLE "users" ADD CONSTRAINT "users_personId_fkey" FOREIGN KEY ("personId") REFERENCES "people"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "import_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "record_sequences" ADD CONSTRAINT "record_sequences_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_records" ADD CONSTRAINT "event_records_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "automation_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent_principals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "widget_bindings" ADD CONSTRAINT "widget_bindings_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "surface_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "widget_bindings" ADD CONSTRAINT "widget_bindings_widgetId_fkey" FOREIGN KEY ("widgetId") REFERENCES "widget_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

