import type { AxisOutcome } from '@kaizen/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static badRequest(message: string, details?: unknown) {
    return new ApiError(400, 'BAD_REQUEST', message, details);
  }

  static unauthorized(message = 'Authentication required') {
    return new ApiError(401, 'UNAUTHENTICATED', message);
  }

  /**
   * A five-axis denial. Carries which axis denied and why, so the UI can show
   * `authority_shortfall_behaviour → escalate_to` as a one-tap control on the
   * failing action itself, rather than a disabled button.
   */
  static forbidden(message: string, axes?: AxisOutcome[]) {
    return new ApiError(403, 'FORBIDDEN', message, { axes });
  }

  /**
   * Used for a cross-tenant reach and for a genuinely missing record alike —
   * the record does not exist from the requester's vantage point.
   */
  static notFound(what = 'Record') {
    return new ApiError(404, 'NOT_FOUND', `${what} not found`);
  }

  /**
   * The dedup-on-create mechanism: a 409 carrying the ranked candidate list, so
   * the caller confirms the match or explicitly force-creates with an
   * audit-logged override reason. Never a silent insert.
   */
  static duplicate(message: string, candidates: unknown[]) {
    return new ApiError(409, 'DUPLICATE', message, { candidates });
  }

  static conflict(message: string, details?: unknown) {
    return new ApiError(409, 'CONFLICT', message, details);
  }

  /** A rejected state transition, a failed predicate, a missing required field. */
  static unprocessable(message: string, details?: unknown) {
    return new ApiError(422, 'UNPROCESSABLE', message, details);
  }

  static internal(message = 'Internal error', details?: unknown) {
    return new ApiError(500, 'INTERNAL', message, details);
  }
}
