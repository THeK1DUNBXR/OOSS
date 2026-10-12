/**
 * Built-in separation-of-duties pairs (ACCESS-MODEL-PLAN s.8: "the built-in pairs are
 * code, not access"). A pair is two sides; a person who holds a side on each one
 * forms the pair. Each side matches when the person holds ANY of its verbs on its
 * resource, so the pair catches the verb however the grant was written.
 *
 * Built-ins are never removed. Tenants may add pairs later; that is not here yet.
 * The pair codes are stable: an override and a finding refer to them by code.
 *
 * Resources are plain strings on purpose. `rate_tables` is not in RESOURCES below,
 * and the statutory pair is owner-confirmed on it (REGISTRY, 2026-10-12 12:05Z);
 * the seed's ALL_RESOURCES is the list a test checks each name against.
 */

import type { Verb } from './permissions.js';

export interface SodSide {
  resource: string;
  /** The person matches this side by holding any one of these verbs on the resource. */
  verbs: Verb[];
}

export interface SodPair {
  /** Stable snake_case code; findings and overrides name the pair by it. */
  pairCode: string;
  a: SodSide;
  b: SodSide;
}

export const BUILT_IN_SOD_PAIRS: readonly SodPair[] = [
  {
    // No code gates `payments:approve` today: the payment path records receipts and
    // reversals without an approval step (finance.ts:126, :221, :282). Until the
    // approval step lands, this pair blocks only the grant of both permissions to one
    // person. It does not stop any payment, because nothing in the payment path
    // enforces approval. Owner, 2026-10-12.
    pairCode: 'payment_create_approve',
    a: { resource: 'payments', verbs: ['create'] },
    b: { resource: 'payments', verbs: ['approve'] },
  },
  {
    // Edit is COMPUTE, which records the preparer (domains/payroll.ts:229). The
    // Self-Dealing Bar bars that same person from approving the run (payroll.ts:222),
    // so holding both is the pair the bar exists to stop.
    pairCode: 'payroll_run_approve',
    a: { resource: 'payroll', verbs: ['edit'] },
    b: { resource: 'payroll', verbs: ['approve'] },
  },
  {
    // A person who can change the access levels and also confirm access would approve
    // their own access. Approval of an assignment is access_assignments:approve
    // (assignments.ts:331).
    pairCode: 'access_manage_approve',
    a: { resource: 'access_model', verbs: ['create', 'edit'] },
    b: { resource: 'access_assignments', verbs: ['approve'] },
  },
  {
    // Statutory rules are guarded by rate_tables: edit to change (statutory.ts:40),
    // approve to sign off (statutory.ts:127). Maker and checker must differ, and this
    // pair is what stops one person holding both.
    pairCode: 'statutory_rule_change_signoff',
    a: { resource: 'rate_tables', verbs: ['edit'] },
    b: { resource: 'rate_tables', verbs: ['approve'] },
  },
];
