/**
 * Audience & segmentation management (MKT-AUD-001 through MKT-AUD-020).
 *
 * Marketing never owns the Person, Student, Organization, or Institution
 * record — it queries CRM's own entities and layers rule-based membership
 * and suppression on top. Audiences can be dynamic (rule-based) or static
 * (imported). Suppression lists prevent sending to certain people.
 *
 * Every audience has a member count and evaluation timestamp; evaluation is
 * on-demand or scheduled. Member count is cached and marked "as-of" a time,
 * not real-time.
 */

import { z } from 'zod';
import { prisma } from '../../platform/db.js';
import { currentAuth, getContext } from '../../platform/context.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan } from '../../platform/permissions.js';
import { publishEvent } from '../../platform/eventBus.js';
import { nextRecordCode } from '../../platform/recordCode.js';

// ============================================================================
// Types & Schemas
// ============================================================================

export interface AudienceView {
  id: string;
  recordCode: string;
  tenantId: string;
  name: string;
  kind: 'dynamic' | 'static' | 'suppression';
  entityType: 'person' | 'student' | 'organization' | 'institution' | 'lead';
  memberCount: number;
  lastEvaluatedAt: Date;
  rules?: object; // Rule tree for dynamic audiences; null for static/suppression
  description?: string;
  createdBy: { id: string; name: string };
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
}

const RuleSchema = z.lazy(() =>
  z.object({
    kind: z.enum(['and', 'or', 'condition']),
    // For 'condition' kind:
    //   field: string (e.g. "enrollmentStatus", "createdAt", "revenue")
    //   op: enum [eq, neq, gt, gte, lt, lte, contains, in, between, rel_days_ago, rel_days_hence]
    //   value: string | number | boolean | string[] | [number, number]
    // For 'and'/'or' kind:
    //   children: Rule[]
    children: z.array(RuleSchema).optional(),
    field: z.string().optional(),
    op: z.string().optional(),
    value: z.unknown().optional(),
  }),
);

export const AudienceInputSchema = z.object({
  name: z.string().min(1).max(255),
  kind: z.enum(['dynamic', 'static', 'suppression']),
  entityType: z.enum(['person', 'student', 'organization', 'institution', 'lead']),
  rules: RuleSchema.optional(),
  description: z.string().optional(),
});

export type AudienceInput = z.infer<typeof AudienceInputSchema>;

// ============================================================================
// Audience CRUD
// ============================================================================

/**
 * Create a new audience (dynamic or static) (MKT-AUD-001, MKT-AUD-002).
 */
export async function createAudience(ctx = getContext(), data: AudienceInput): Promise<AudienceView> {
  await assertCan({ resource: 'audiences', verb: 'create' });

  const parsed = AudienceInputSchema.parse(data);
  const recordCode = await nextRecordCode('AUD');

  // TODO: Create audience row once Prisma schema is available
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * List audiences visible to the current user (MKT-AUD-001).
 */
export async function listAudiences(ctx = getContext(), opts?: { kind?: string; entityType?: string }): Promise<AudienceView[]> {
  await assertCan({ resource: 'audiences', verb: 'view' });

  // TODO: Query and return audiences
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Load a single audience by ID (MKT-AUD-001).
 */
export async function loadAudience(ctx = getContext(), id: string): Promise<AudienceView> {
  await assertCan({ resource: 'audiences', verb: 'view' });

  // TODO: Load and return audience
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Update an audience's rules or description (MKT-AUD-002).
 *
 * For dynamic audiences, changing rules triggers re-evaluation to update
 * memberCount. Static lists are not re-evaluated (members are fixed until
 * explicitly added/removed).
 */
export async function updateAudience(ctx = getContext(), id: string, data: Partial<AudienceInput>): Promise<AudienceView> {
  await assertCan({ resource: 'audiences', verb: 'edit' });

  // TODO: Update audience, re-evaluate if dynamic, publish event
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

// ============================================================================
// Evaluation & Membership
// ============================================================================

/**
 * Evaluate a dynamic audience's rules and update memberCount (MKT-AUD-003).
 *
 * Scans all entities matching entityType and evaluates rules against them.
 * Sets memberCount and lastEvaluatedAt. For static audiences, this is a no-op
 * (members are fixed). For suppression lists, "member" means "suppressed".
 *
 * In production, this would be run async (background job or scheduled);
 * for now, implemented synchronously for simplicity.
 */
export async function evaluateAudience(ctx = getContext(), id: string): Promise<AudienceView> {
  await assertCan({ resource: 'audiences', verb: 'view' });

  // TODO: Load audience, run rule evaluator, update memberCount, publish event
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Add a member to a static or suppression audience (MKT-AUD-004, MKT-AUD-005).
 *
 * For suppression lists, "add" means "mark as suppressed".
 * Raises DUPLICATE_MEMBER if already present.
 */
export async function addAudienceMember(ctx = getContext(), audienceId: string, entityId: string): Promise<void> {
  await assertCan({ resource: 'audiences', verb: 'edit' });

  // TODO: Add row to audience_members, increment memberCount, publish event
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Suppress a member (add to suppression list) (MKT-AUD-005).
 *
 * A convenience wrapper for adding to a suppression audience. Sets
 * suppressed = true on the membership row.
 */
export async function suppressMember(ctx = getContext(), audienceId: string, personId: string): Promise<void> {
  await assertCan({ resource: 'audiences', verb: 'edit' });

  // TODO: Set suppressed=true, publish event
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * List members of an audience, paginated (MKT-AUD-006).
 */
export async function listAudienceMembers(
  ctx = getContext(),
  audienceId: string,
  opts?: { page?: number; pageSize?: number; suppressed?: boolean },
): Promise<Array<{ entityId: string; entityType: string; addedAt: Date; source: string; suppressed: boolean }>> {
  await assertCan({ resource: 'audiences', verb: 'view' });

  // TODO: Query and return members
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}
