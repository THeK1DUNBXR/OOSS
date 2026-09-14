/**
 * Technology — assets and devices (docs/plan/cio.md, workstream A).
 *
 * The pure arithmetic and the lifecycle machine `apps/api/src/domains/it/
 * assets.ts` and its screens share. Nothing here reads a database: the
 * warranty ladder rung and an asset's book value are both computed from
 * numbers passed in, so they are tested without one (IT-AST-003, and the
 * `warrantyRung`/`assetBookValue` unit tests).
 */

import { createMachine, type Machine } from '../hr.js';
import type { ItSummaryBase } from './common.js';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const IT_ASSET_KINDS = [
  'laptop',
  'desktop',
  'phone',
  'monitor',
  'peripheral',
  'network',
  'server',
  'other',
] as const;
export type ItAssetKind = (typeof IT_ASSET_KINDS)[number];

export const IT_ASSET_CONDITIONS = ['new', 'good', 'fair', 'poor', 'damaged'] as const;
export type ItAssetCondition = (typeof IT_ASSET_CONDITIONS)[number];

export const IT_ASSET_EVENT_KINDS = ['repair', 'audit', 'note', 'transition'] as const;
export type ItAssetEventKind = (typeof IT_ASSET_EVENT_KINDS)[number];

// ---------------------------------------------------------------------------
// Lifecycle — Diagram: in_stock -> assigned -> in_repair -> retired -> disposed
// ---------------------------------------------------------------------------

export type ItAssetStatus = 'in_stock' | 'assigned' | 'in_repair' | 'retired' | 'disposed';

export type ItAssetLifecycleEvent =
  | 'ASSIGN'
  | 'RETURN'
  | 'SEND_TO_REPAIR'
  | 'BACK_FROM_REPAIR'
  | 'RETIRE'
  | 'DISPOSE';

/** Past-tense verb per transition, for the event name and the audit trail. */
export const IT_ASSET_EVENT_VERB: Record<ItAssetLifecycleEvent, string> = {
  ASSIGN: 'assigned',
  RETURN: 'returned',
  SEND_TO_REPAIR: 'sent_to_repair',
  BACK_FROM_REPAIR: 'returned_from_repair',
  RETIRE: 'retired',
  DISPOSE: 'disposed',
};

/**
 * `disposed` is reachable only through `retired` — never directly from
 * `assigned` or `in_stock` (IT-AST-001). An asset already in repair or
 * retired cannot be (re)assigned without first coming back to `in_stock`.
 */
export const itAssetMachine: Machine<ItAssetStatus, ItAssetLifecycleEvent> = createMachine<
  ItAssetStatus,
  ItAssetLifecycleEvent
>('ItAsset', {
  in_stock: { ASSIGN: 'assigned', SEND_TO_REPAIR: 'in_repair', RETIRE: 'retired' },
  assigned: { RETURN: 'in_stock', SEND_TO_REPAIR: 'in_repair', RETIRE: 'retired' },
  in_repair: { BACK_FROM_REPAIR: 'in_stock', RETIRE: 'retired' },
  retired: { DISPOSE: 'disposed' },
  disposed: {},
});

// ---------------------------------------------------------------------------
// Warranty ladder (pure arithmetic, no DB — IT-AST-003)
// ---------------------------------------------------------------------------

/** The default ladder, only used when a tenant's `ItAssetThreshold` row is
 * unavailable at the call site — the seeded row is the one actually in
 * force (Principle 4: service targets are data, not constants). */
export const DEFAULT_IT_ASSET_WARRANTY_RUNGS = [90, 30, 7, 0] as const;

/**
 * Which warranty ladder rung `daysLeft` has crossed — the tightest (smallest)
 * rung still at or above `daysLeft`, or `null` when the warranty is outside
 * every rung (still comfortably in force). `rungs` must be sorted descending;
 * the last rung is read as "expired" once `daysLeft` falls to it or below.
 *
 * Mirrors `CALENDAR_LADDER_RUNGS` reasoning in
 * `packages/shared/src/compliance/calendar.ts`: the widest rung crossed is
 * mildest, the tightest is what describes the situation right now.
 */
export function warrantyRung(daysLeft: number, rungs: readonly number[] = DEFAULT_IT_ASSET_WARRANTY_RUNGS): number | null {
  const sorted = [...rungs].sort((a, b) => b - a);
  const crossed = sorted.filter((r) => daysLeft <= r);
  if (!crossed.length) return null;
  return crossed[crossed.length - 1];
}

/** Whole days between `now` and `end` — negative once `end` has passed. */
export function daysUntil(end: Date, now: Date = new Date()): number {
  return Math.ceil((end.getTime() - now.getTime()) / 86_400_000);
}

/** Whole days an asset has sat in `in_repair` as of `now`. */
export function daysInRepair(since: Date, now: Date = new Date()): number {
  return Math.floor((now.getTime() - since.getTime()) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Book value (pure arithmetic, no DB)
// ---------------------------------------------------------------------------

/** Sums the purchase cost of every asset passed in — the caller is
 * responsible for excluding `disposed` rows first, so the function itself
 * stays a plain reduction with nothing to get wrong. */
export function assetBookValue(costs: Array<number | null | undefined>): number {
  return costs.reduce((sum: number, c) => sum + (typeof c === 'number' && Number.isFinite(c) ? c : 0), 0);
}

// ---------------------------------------------------------------------------
// View types
// ---------------------------------------------------------------------------

export interface ItAssetSummary extends ItSummaryBase {
  byKind: Record<string, number>;
  byStatus: Record<string, number>;
  warrantyExpiringIn90Days: number;
  unassignedStock: number;
  topHolders: Array<{ partyId: string; fullName: string; count: number }>;
  bookValue: number;
  fixedAssetLinkedCount: number;
  total: number;
}
