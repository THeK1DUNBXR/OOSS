/**
 * Marketing automation journeys (MKT-MSG-013 through MKT-MSG-018).
 *
 * A journey is a drip sequence triggered by events (audience membership, form
 * submission, enrollment). Steps are delayed sends or other actions. Journeys
 * can be automated for thousands of people in parallel.
 */

import { ApiError } from '../../platform/errors.js';
import { assertCan, getContext } from '../../platform/context.js';

export interface JourneyView {
  id: string;
  recordCode: string;
  name: string;
  triggerKind: 'audience_join' | 'lead_created' | 'form_submitted' | 'event_registered' | 'enrolment' | 'manual';
  status: 'draft' | 'active' | 'paused' | 'retired';
  steps: object; // [{delayDays, templateId, channelKey, condition?}, ...]
  createdBy: { id: string; name: string };
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Create a journey in draft state (MKT-MSG-013).
 */
export async function createJourney(ctx = getContext(), data: { name: string; triggerKind: string; steps: object }): Promise<JourneyView> {
  await assertCan({ resource: 'marketing_journeys', verb: 'create' });

  // TODO: Create journey row
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * List journeys (MKT-MSG-013).
 */
export async function listJourneys(ctx = getContext()): Promise<JourneyView[]> {
  // TODO: Query journeys
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Load a journey (MKT-MSG-013).
 */
export async function loadJourney(ctx = getContext(), id: string): Promise<JourneyView> {
  // TODO: Load journey
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Update a journey in draft state (MKT-MSG-014).
 */
export async function updateJourney(ctx = getContext(), id: string, data: Partial<JourneyView>): Promise<JourneyView> {
  // TODO: Update journey
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Activate a journey (draft → active) (MKT-MSG-015).
 */
export async function activateJourney(ctx = getContext(), id: string): Promise<JourneyView> {
  // TODO: Transition to active
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Pause an active journey (MKT-MSG-016).
 */
export async function pauseJourney(ctx = getContext(), id: string): Promise<JourneyView> {
  // TODO: Transition to paused
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Resume a paused journey (MKT-MSG-016).
 */
export async function resumeJourney(ctx = getContext(), id: string): Promise<JourneyView> {
  // TODO: Transition to active
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Retire a journey (any → retired) (MKT-MSG-017).
 */
export async function retireJourney(ctx = getContext(), id: string): Promise<JourneyView> {
  // TODO: Transition to retired
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * List active runs of a journey (MKT-MSG-018).
 */
export async function listJourneyRuns(ctx = getContext(), journeyId: string): Promise<Array<{ personId: string; currentStep: number; status: string; nextAt: Date }>> {
  // TODO: Query journey runs
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}
