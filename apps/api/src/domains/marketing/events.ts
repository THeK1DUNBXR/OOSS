/**
 * Events & registrations (MKT-EVT-001 through MKT-EVT-012).
 */

import { ApiError } from '../../platform/errors.js';
import { assertCan, getContext } from '../../platform/context.js';

/**
 * Create an event (MKT-EVT-001).
 */
export async function createEvent(ctx = getContext(), data: { name: string; kind: string; startAt: Date; endAt: Date; venue?: string }): Promise<object> {
  await assertCan({ resource: 'marketing_events', verb: 'create' });
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * List events (MKT-EVT-001).
 */
export async function listEvents(ctx = getContext()): Promise<object[]> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Load an event (MKT-EVT-001).
 */
export async function loadEvent(ctx = getContext(), id: string): Promise<object> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Update an event (MKT-EVT-002).
 */
export async function updateEvent(ctx = getContext(), id: string, data: Partial<object>): Promise<object> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Register a person for an event (MKT-EVT-003).
 */
export async function registerForEvent(ctx = getContext(), eventId: string, personId: string): Promise<object> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Cancel a registration (MKT-EVT-004).
 */
export async function cancelRegistration(ctx = getContext(), eventId: string, personId: string): Promise<void> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Check in an attendee (MKT-EVT-005).
 */
export async function checkInAttendee(ctx = getContext(), eventId: string, personId: string): Promise<object> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * List registrations for an event (MKT-EVT-006).
 */
export async function listEventRegistrations(ctx = getContext(), eventId: string): Promise<object[]> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Close an event (mark completed) (MKT-EVT-007).
 */
export async function closeEvent(ctx = getContext(), id: string): Promise<object> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

export interface EventView {
  id: string;
  recordCode: string;
  name: string;
  kind: string;
  startAt: Date;
  endAt: Date;
  status: 'planned' | 'open' | 'closed' | 'live' | 'completed' | 'cancelled';
}
