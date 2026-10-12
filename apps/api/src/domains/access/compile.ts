/**
 * Compiles a confirmed access assignment into Grant rows (Wave 6 PR11b;
 * ACCESS-MODEL-PLAN s.4-s.5; P11-DESIGN c, b).
 *
 * Each compiled row is an individual grant tagged with its assignment
 * (Grant.accessAssignmentId). A recompile and an expiry touch only tagged rows, so a
 * role or individual grant is never removed by this module.
 *
 * PR11b red stage: the signatures are fixed here so the tests compile; the bodies
 * throw until the implementation commits fill them in.
 */

import type { DbTx } from '../../platform/db.js';
import type { Reach } from './rules.js';

export interface CompileRule {
  resource: string;
  verbs: string[];
}

export interface CompilePlacement {
  verticalCode: string;
  /** The unit's code, or '' for the whole vertical. */
  unitCode: string;
  reach: Reach;
  /** The capability rules the placement's vertical and level carry (AccessCapabilityRule). */
  rules: CompileRule[];
}

export interface CompileInput {
  assignmentId: string;
  personId: string;
  placements: CompilePlacement[];
}

/** The Grant columns a compiled row writes, without tenantId. */
export interface GrantRowSpec {
  accessAssignmentId: string;
  principalType: 'individual';
  principalId: string;
  resource: string;
  verbs: string[];
  scope: 'own' | 'all';
  scopeResolver: 'vertical' | null;
  conditions: { verticalCode?: string; unitCode?: string };
}

/** Pure: the Grant rows a confirmed assignment compiles to. No database. */
export function compileRows(input: CompileInput): GrantRowSpec[] {
  void input;
  throw new Error('PR11b: compileRows is not implemented yet');
}

/** Writes the assignment's tagged Grant rows inside the caller's transaction. */
export async function compileAssignmentTx(tx: DbTx, assignmentId: string): Promise<number> {
  void tx;
  void assignmentId;
  throw new Error('PR11b: compileAssignmentTx is not implemented yet');
}

/** Recompiles one assignment in its own governed write, for tests and maintenance. */
export async function recompileAssignment(assignmentId: string): Promise<number> {
  void assignmentId;
  throw new Error('PR11b: recompileAssignment is not implemented yet');
}

/** Access grants whose resource has no vertical binding. Empty when every grant can be checked. */
export async function listUnboundVerticalGrants(): Promise<{ grantId: string; resource: string }[]> {
  throw new Error('PR11b: listUnboundVerticalGrants is not implemented yet');
}
