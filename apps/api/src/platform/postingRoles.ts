/**
 * Resolves a posting role to a ledger account (contract FX-70 D2; decision O3).
 *
 * Read-only: the mapping rows are written by the finance head's governed
 * action, never by a posting. The resolver fails closed. No row covering the
 * IST day means a refusal naming the role and its scope, and the caller has no
 * account to fall back to, so a missing mapping cannot silently post to the
 * wrong head of account.
 */

import {
  istCivilDay,
  istDateKey,
  postingAccountKey,
  UNSCOPED,
  type PostingRole,
  type ResolvedPostingAccounts,
} from '@kaizen/shared';
import type { DbTx } from './db.js';
import { currentAuth } from './context.js';
import { ApiError } from './errors.js';

/**
 * A role with no mapping covering the day. A 422 with a stable code, so the UI
 * can send the user to the mapping screen rather than showing a generic failure.
 */
export class PostingRoleUnmappedError extends ApiError {
  constructor(
    readonly role: string,
    readonly scopeKey: string,
    readonly istDay: string,
  ) {
    super(
      422,
      'POSTING_ROLE_UNMAPPED',
      `Account role ${role} is not mapped for ${scopeKey === UNSCOPED ? 'the tenant' : scopeKey} on ${istDay}.`,
      { role, scopeKey, istDay },
    );
    this.name = 'PostingRoleUnmappedError';
  }
}

/**
 * The account a role points at in a scope on the IST day of `asOf`.
 *
 * The covering row is the one with the latest effectiveFrom on or before the
 * day. A row whose effectiveTo is on or before the day is not a covering row:
 * a retired mapping does not fall back to the one it replaced. Rows are
 * insert-only, so a new mapping supersedes an old one by its effectiveFrom
 * alone; nothing is closed off by an update.
 */
export async function resolvePostingAccount(
  tx: DbTx,
  role: PostingRole,
  scopeKey: string,
  asOf: Date,
): Promise<string> {
  const { tenantId } = currentAuth();
  const day = istCivilDay(asOf);
  const row = await tx.ledgerPostingRole.findFirst({
    where: { tenantId, role, scopeKey, effectiveFrom: { lte: day } },
    orderBy: { effectiveFrom: 'desc' },
    select: { ledgerAccountId: true, effectiveTo: true },
  });
  if (!row || (row.effectiveTo !== null && row.effectiveTo <= day)) {
    throw new PostingRoleUnmappedError(role, scopeKey, istDateKey(asOf));
  }
  return row.ledgerAccountId;
}

export interface PostingRoleRef {
  role: PostingRole;
  /** Omitted for an unscoped role. */
  scopeKey?: string;
}

/**
 * Resolves every role a builder needs, for one day, before the build. One
 * unmapped role refuses the whole set: a builder given some accounts and not
 * others would post a partial entry.
 */
export async function resolvePostingAccounts(
  tx: DbTx,
  refs: readonly PostingRoleRef[],
  asOf: Date,
): Promise<ResolvedPostingAccounts> {
  const resolved = new Map<string, string>();
  for (const ref of refs) {
    const scopeKey = ref.scopeKey ?? UNSCOPED;
    resolved.set(postingAccountKey(ref.role, scopeKey), await resolvePostingAccount(tx, ref.role, scopeKey, asOf));
  }
  return resolved;
}
