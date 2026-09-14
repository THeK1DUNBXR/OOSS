/** Shared by every technology workstream (docs/plan/cio.md). */

/** The exception/health domain code every technology exception is raised under. */
export const IT_DOMAIN = 'it' as const;

/** Application criticality tiers: 1 is the business-stopping tier. */
export const IT_TIERS = [1, 2, 3, 4] as const;
export type ItTier = (typeof IT_TIERS)[number];

/** A summary a screen can render as "not yet measured" rather than zero. */
export interface ItSummaryBase {
  notYetMeasured: boolean;
}
