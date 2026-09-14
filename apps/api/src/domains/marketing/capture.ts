/**
 * Forms & lead capture (MKT-CAP-001 through MKT-CAP-008).
 */

import { ApiError } from '../../platform/errors.js';
import { assertCan, getContext } from '../../platform/context.js';

/**
 * Create a form (MKT-CAP-001).
 */
export async function createForm(ctx = getContext(), data: { name: string; fields: object; vertical?: string; thankYouMessage?: string }): Promise<object> {
  await assertCan({ resource: 'marketing_forms', verb: 'create' });
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * List forms (MKT-CAP-001).
 */
export async function listForms(ctx = getContext()): Promise<object[]> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Load a form (MKT-CAP-001).
 */
export async function loadForm(ctx = getContext(), id: string): Promise<object> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Update a form (MKT-CAP-002).
 */
export async function updateForm(ctx = getContext(), id: string, data: Partial<object>): Promise<object> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Publish a form (draft → active) (MKT-CAP-003).
 */
export async function publishForm(ctx = getContext(), id: string): Promise<object> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Archive a form (MKT-CAP-004).
 */
export async function archiveForm(ctx = getContext(), id: string): Promise<object> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Submit a form response (public endpoint) (MKT-CAP-005).
 */
export async function submitFormResponse(ctx = getContext(), publicToken: string, payload: Record<string, unknown>): Promise<{ submissionId: string }> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * List form submissions (MKT-CAP-006).
 */
export async function listFormSubmissions(ctx = getContext(), formId: string): Promise<object[]> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}
