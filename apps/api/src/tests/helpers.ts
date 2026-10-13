/**
 * Test harness.
 *
 * Every test runs inside a real request context against a real database, so the
 * tenant gate, the five-axis evaluator and the event chain are all exercised
 * rather than mocked. A mocked permission check proves nothing about the one
 * that runs in production.
 */

import { unscopedPrisma, prisma } from '../platform/db.js';
import { readyInvoicePosting } from './fixtures/invoicePostingReady.js';
import type { PayoutRequest, Transaction, VendorBill } from '@prisma/client';
import type { TransactionInput } from '../domains/books.js';
import { payVendorBill, recordTransaction, reverseTransaction } from '../domains/books.js';
import { approvePayout, requestRecurringRuleApproval } from '../domains/payouts.js';
import { asSystem, newRequestContext, runWithContext, type AuthContext } from '../platform/context.js';
import { invalidateGrantCache } from '../platform/permissions.js';
import { registerSubscribers } from '../events/handlers.js';
import { ROLE_CLASSIFICATION_CEILING, type SensitivityClass } from '@kaizen/shared';
import { randomBytes, randomUUID } from 'node:crypto';
import { hashPassword, hashRefreshSecret, signToken } from '../lib/auth.js';
import { ROLE_DEFINITIONS, ROLE_GRANT_MATRIX, parseCell } from '../seed/grants.js';
import { seedBooks } from '../seed/compliance/books.js';
import { closePeriod, reopenPeriod, requestClosePeriod } from '../domains/compliance/books.js';

export interface TestPrincipal {
  tenantId: string;
  partyId: string;
  userId: string;
  affiliationId: string;
  roleSlug: string;
  branch: string | null;
}

let subscribersRegistered = false;

export async function tenantId(slug = 'kaizen'): Promise<string> {
  const t = await unscopedPrisma.tenant.findFirstOrThrow({ where: { slug } });
  return t.id;
}

export async function principalFor(email: string): Promise<TestPrincipal> {
  // The suite's people live in the `kaizen` tenant. Equity tests bootstrap
  // subsidiary tenants whose founding accounts carry the same emails (one
  // principal, several entities), so the lookup names the tenant rather
  // than taking whichever row the database returns first.
  const user =
    (await unscopedPrisma.user.findFirst({
      where: { email, tenant: { slug: 'kaizen' } },
      include: { person: true },
    })) ?? (await unscopedPrisma.user.findFirstOrThrow({ where: { email }, include: { person: true } }));
  const affiliation = await unscopedPrisma.affiliation.findFirstOrThrow({
    where: { partyId: user.personId, status: 'active' },
    orderBy: [{ primaryFlag: 'desc' }, { createdAt: 'asc' }],
  });
  return {
    tenantId: user.tenantId,
    partyId: user.personId,
    userId: user.id,
    affiliationId: affiliation.id,
    roleSlug: affiliation.roleSlug ?? 'sales',
    branch: user.branch,
  };
}

export function authFor(p: TestPrincipal, overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    tenantId: p.tenantId,
    principalType: 'human',
    partyId: p.partyId,
    userId: p.userId,
    agentId: null,
    onBehalfOfPartyId: null,
    affiliationId: p.affiliationId,
    roleSlug: p.roleSlug,
    branch: p.branch,
    orgUnitId: null,
    classificationCeiling: (ROLE_CLASSIFICATION_CEILING[p.roleSlug] ?? 'internal') as SensitivityClass,
    purpose: 'operational',
    consentCodes: [],
    stepUpVerified: true,
    ...overrides,
  };
}

/** Runs `fn` as the given account, inside a fresh request context. */
export async function asUser<T>(email: string, fn: (p: TestPrincipal) => Promise<T>): Promise<T> {
  if (!subscribersRegistered) {
    registerSubscribers();
    subscribersRegistered = true;
  }
  invalidateGrantCache();
  const p = await principalFor(email);
  // Awaited *inside* the context: a Prisma promise is lazy, so returning it
  // unawaited would run the query after the async scope had already exited.
  return runWithContext(newRequestContext({ auth: authFor(p) }), async () => await fn(p));
}

/** Runs `fn` with an explicitly constructed principal — used for agent and cross-tenant cases. */
export async function asPrincipal<T>(auth: AuthContext, fn: () => Promise<T>): Promise<T> {
  invalidateGrantCache();
  return runWithContext(newRequestContext({ auth }), async () => await fn());
}

/**
 * Money out in the suite goes through the gate (owner ruling 2026-10-13). The second holder
 * who approves it is the chairman: the founder, so the founder exemption never applies to a
 * request somebody else made, and the only payments:approve holder (seed/grants.ts). A test
 * that asks as the founder gets a request that counts at once, as it would in production.
 *
 * These helpers keep the old return values, so an assertion about the cashbook row or the
 * bill reads exactly as it did before the gate. The gate itself, and the refusals, are tested
 * in tests/payoutApproval.test.ts.
 */
export const PAYOUT_APPROVER_EMAIL = 'chairman@kaizen.co.in';

/**
 * Runs `fn` with MFA enrolled for `email` for the duration of the call, then puts the user's
 * enrolment back. assertStepUpForApprove (domains/compliance/corporate/security.ts) refuses an
 * approver whose role is in the MFA policy and who has not enrolled, and the chairman is in
 * that policy (seed/compliance/corporate.ts). The policy is left as it is; the test enrols the
 * approver for the call only.
 */
export async function withMfaEnrolled<T>(email: string, fn: () => Promise<T>): Promise<T> {
  const user =
    (await unscopedPrisma.user.findFirst({ where: { email, tenant: { slug: 'kaizen' } } })) ??
    (await unscopedPrisma.user.findFirstOrThrow({ where: { email } }));
  const before = { mfaSecret: user.mfaSecret, mfaEnabledAt: user.mfaEnabledAt };
  await unscopedPrisma.user.update({ where: { id: user.id }, data: { mfaEnabledAt: new Date() } });
  try {
    return await fn();
  } finally {
    await unscopedPrisma.user.update({ where: { id: user.id }, data: before });
  }
}

/** approvePayout as the second holder, with that holder enrolled in MFA for the call. */
export async function approvePayoutAs(email: string, id: string, note?: string | null) {
  return withMfaEnrolled(email, () => asUser(email, () => approvePayout(id, note)));
}

/**
 * The second holder for a request in `tenant`: the kaizen chairman, or the chairman of a books
 * tenant (booksTenant), since a request is approved inside the tenant it was made in.
 */
async function approverEmailFor(tenant: string): Promise<string> {
  if (tenant === (await tenantId())) return PAYOUT_APPROVER_EMAIL;
  const aff = await unscopedPrisma.affiliation.findFirstOrThrow({
    where: { tenantId: tenant, roleSlug: 'chairman', status: 'active' },
  });
  const user = await unscopedPrisma.user.findFirstOrThrow({ where: { tenantId: tenant, personId: aff.partyId } });
  return user.email;
}

async function settledRequest(request: PayoutRequest): Promise<PayoutRequest> {
  if (request.state === 'approved') return request;
  const settled = await approvePayoutAs(await approverEmailFor(request.tenantId), request.id);
  return settled.request;
}

async function transactionOfSettled(request: PayoutRequest): Promise<Transaction> {
  const settled = await settledRequest(request);
  if (!settled.transactionId) throw new Error(`payout ${settled.recordCode} settled without a transaction`);
  return unscopedPrisma.transaction.findUniqueOrThrow({ where: { id: settled.transactionId } });
}

/** recordTransaction for an outward row, approved by the second holder. Returns the Transaction. */
export async function payOutSettled(input: TransactionInput & { direction: 'out' }): Promise<Transaction> {
  return transactionOfSettled(await recordTransaction(input));
}

/** payVendorBill, approved by the second holder. Returns the bill and the Transaction, as before the gate. */
export async function payBillSettled(
  id: string,
  input: { amount: number; accountId: string; paidOn: Date; reference?: string | null },
): Promise<{ bill: VendorBill; transaction: Transaction }> {
  const transaction = await transactionOfSettled(await payVendorBill(id, input));
  const bill = await unscopedPrisma.vendorBill.findUniqueOrThrow({ where: { id } });
  return { bill, transaction };
}

/** reverseTransaction, approved by the second holder when the entry reversed is an inward one. */
export async function reverseSettled(id: string, reason: string): Promise<Transaction> {
  const result = await reverseTransaction(id, reason);
  if (!('amountMinor' in result)) return result;
  return transactionOfSettled(result);
}

/** requestRecurringRuleApproval, approved by the second holder. Returns the approved request. */
export async function approveRecurringRuleSettled(ruleId: string): Promise<PayoutRequest> {
  return settledRequest(await requestRecurringRuleApproval(ruleId));
}

/** Asserts that `fn` rejects, and returns the error for inspection. */
export async function expectReject(
  fn: () => Promise<unknown>,
): Promise<{ code?: string; message: string; status?: number }> {
  try {
    await fn();
  } catch (err) {
    const e = err as { code?: string; message: string; status?: number };
    return { code: e.code, message: e.message, status: e.status };
  }
  throw new Error('Expected the call to reject, but it resolved.');
}

/**
 * A role that exists only for the duration of a test.
 *
 * The product ships three roles, and several of the permission engine's
 * mechanisms no longer have a product role that demonstrates them: nothing
 * carries `own_or_unowned`, every role's classification ceiling is
 * `regulated`, and no role holds `edit` on an agreement without `approve`.
 *
 * Deleting those tests would be the wrong trade. The mechanisms are still in
 * the evaluator, still reachable the moment a tenant writes its own grant row,
 * and an untested authorisation path is exactly the kind of thing that rots.
 * So the suite builds the principal it needs: a role, its grants, a person and
 * a user, torn down after the assertion.
 *
 * This is also the honest statement of what the matrix is. Roles are data. A
 * tenant that wants a narrow counsellor role writes one, and it will behave
 * the way these tests say it behaves.
 */
export async function withFixtureRole<T>(
  spec: {
    slug?: string;
    classificationCeiling?: SensitivityClass;
    grants: Array<{ resource: string; verbs: string[]; scope?: string; scopeResolver?: string }>;
    branch?: string;
  },
  fn: (p: TestPrincipal) => Promise<T>,
): Promise<T> {
  const tid = await tenantId();
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const slug = `${spec.slug ?? 'fixture'}_${stamp}`;
  const email = `${slug}@fixture.test`;

  const role = await unscopedPrisma.accessRole.create({
    data: {
      tenantId: tid,
      slug,
      name: `Fixture ${slug}`,
      description: 'Created by the acceptance suite. Not a product role.',
      archetype: 'workspace',
      classificationCeiling: spec.classificationCeiling ?? 'internal',
      isSystem: false,
    },
  });

  for (const g of spec.grants) {
    await unscopedPrisma.grant.create({
      data: {
        tenantId: tid,
        principalType: 'role',
        roleId: role.id,
        resource: g.resource,
        verbs: g.verbs,
        scope: g.scope ?? 'all',
        scopeResolver: g.scopeResolver ?? null,
      },
    });
  }

  const person = await unscopedPrisma.person.create({
    data: {
      tenantId: tid,
      recordCode: `PER-FIXTURE-${stamp}`,
      fullName: `Fixture ${slug}`,
      primaryEmail: email,
      primaryEmailNormalised: email,
      source: 'test',
    },
  });
  const affiliation = await unscopedPrisma.affiliation.create({
    data: {
      tenantId: tid,
      partyId: person.id,
      affiliationType: 'employee',
      counterpartyName: 'Fixture',
      roleSlug: slug,
      primaryFlag: true,
      status: 'active',
      branch: spec.branch ?? 'Chennai',
    },
  });
  const user = await unscopedPrisma.user.create({
    data: { tenantId: tid, personId: person.id, email, passwordHash: 'not-a-login', branch: spec.branch ?? 'Chennai' },
  });

  const principal: TestPrincipal = {
    tenantId: tid,
    partyId: person.id,
    userId: user.id,
    affiliationId: affiliation.id,
    roleSlug: slug,
    branch: spec.branch ?? 'Chennai',
  };

  if (!subscribersRegistered) {
    registerSubscribers();
    subscribersRegistered = true;
  }
  invalidateGrantCache();

  const auth = authFor(principal, {
    classificationCeiling: spec.classificationCeiling ?? 'internal',
  });

  try {
    return await runWithContext(newRequestContext({ auth }), async () => await fn(principal));
  } finally {
    // Torn down so a second run of the suite does not accumulate roles, and so
    // the grant reconciler never sees a row the matrix does not declare.
    await unscopedPrisma.grant.deleteMany({ where: { roleId: role.id } });
    await unscopedPrisma.affiliation.delete({ where: { id: affiliation.id } });
    await unscopedPrisma.user.delete({ where: { id: user.id } });
    await unscopedPrisma.accessRole.delete({ where: { id: role.id } });
    invalidateGrantCache();
  }
}

/**
 * A bearer token for a principal without going through login: writes the
 * Session row a real sign-in would, then signs the access token against it.
 * Tokens minted by `signToken` alone have no live session and are refused.
 */
export async function sessionToken(p: {
  userId: string;
  tenantId: string;
  affiliationId: string;
  stepUp: boolean;
}): Promise<string> {
  const jti = randomUUID();
  await unscopedPrisma.session.create({
    data: {
      tenantId: p.tenantId,
      userId: p.userId,
      jti,
      refreshTokenHash: hashRefreshSecret(randomBytes(32).toString('base64url')),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  return signToken({ ...p, jti });
}

/**
 * A books tenant of its own, for a file that closes and reopens accounting periods.
 *
 * The period order rule (domains/compliance/books.ts, requestClosePeriod and
 * closePeriod) reads every earlier month of the tenant, so a file that closes a
 * month in the shared `kaizen` tenant freezes whatever other files wrote into its
 * earlier months. A tenant of its own keeps a file's months to itself.
 *
 * Find-or-create by slug: the database outlives a run, so a second run finds the
 * tenant, the entity, the accounts and the principals the first run made.
 *
 * The principals are built the way the seed gives a founding account its role
 * (seed/bootstrap.ts, seedAccount and seedGrants): a Principal with a hashed
 * credential, a Person, a User, and an active Affiliation whose roleSlug names an
 * AccessRole. The role's grants are the matrix rows the seed writes for it
 * (ROLE_GRANT_MATRIX through parseCell), so the evaluator decides with the same
 * rows it decides with in `kaizen`. Nothing here bypasses the evaluator.
 */
export interface BooksTenant {
  tenantId: string;
  entityId: string;
  /** An account of type `bank`, the one the books' own writes post to. */
  bankAccountId: string;
  /** A ledger category the books' own writes file under. */
  categoryId: string;
  /** An organisation the books' invoices are raised against. */
  organizationId: string;
  /** The finance head: asks for a close, and is refused approving it. */
  finance: string;
  /** The chairman: approves a close and reopens a period. */
  chairman: string;
}

async function ensurePrincipalForRole(
  tid: string,
  slug: string,
  roleSlug: string,
  email: string,
  name: string,
): Promise<string> {
  const role = await ensureRoleWithGrants(tid, roleSlug);
  const principal =
    (await unscopedPrisma.principal.findFirst({ where: { email } })) ??
    (await unscopedPrisma.principal.create({
      data: { email, passwordHash: await hashPassword(randomUUID()) },
    }));
  const person =
    (await unscopedPrisma.person.findFirst({ where: { tenantId: tid, primaryEmail: email } })) ??
    (await unscopedPrisma.person.create({
      data: {
        tenantId: tid,
        recordCode: `PER-${slug.toUpperCase()}-${roleSlug.toUpperCase()}`,
        fullName: name,
        primaryEmail: email,
        primaryEmailNormalised: email,
        source: 'test',
      },
    }));
  const affiliation = await unscopedPrisma.affiliation.findFirst({
    where: { tenantId: tid, partyId: person.id, roleSlug: role.slug },
  });
  if (!affiliation) {
    await unscopedPrisma.affiliation.create({
      data: {
        tenantId: tid,
        partyId: person.id,
        affiliationType: 'employee',
        counterpartyName: `Books fixture ${slug}`,
        roleSlug: role.slug,
        primaryFlag: true,
        status: 'active',
      },
    });
  }
  const user = await unscopedPrisma.user.findFirst({ where: { tenantId: tid, email } });
  if (!user) {
    await unscopedPrisma.user.create({
      data: { tenantId: tid, personId: person.id, email, principalId: principal.id },
    });
  }
  return email;
}

/** The seed's role row and grant rows for one role (seed/bootstrap.ts, seedGrants), without the policy version the seed also stamps. */
async function ensureRoleWithGrants(tid: string, roleSlug: string) {
  const def = ROLE_DEFINITIONS.find((d) => d.slug === roleSlug);
  if (!def) throw new Error(`No role definition for ${roleSlug} in seed/grants.ts`);
  const role = await unscopedPrisma.accessRole.upsert({
    where: { tenantId_slug: { tenantId: tid, slug: def.slug } },
    create: {
      tenantId: tid,
      slug: def.slug,
      name: def.name,
      description: def.description,
      archetype: def.archetype,
      classificationCeiling: def.classificationCeiling,
      isSystem: true,
    },
    update: {},
  });
  for (const spec of ROLE_GRANT_MATRIX[def.slug] ?? []) {
    const parsed = parseCell(spec.cell);
    if (!parsed) continue;
    const existing = await unscopedPrisma.grant.findFirst({
      where: { tenantId: tid, roleId: role.id, resource: spec.resource, scope: parsed.scope },
    });
    if (existing) continue;
    await unscopedPrisma.grant.create({
      data: {
        tenantId: tid,
        principalType: 'role',
        roleId: role.id,
        resource: spec.resource,
        verbs: parsed.verbs,
        scope: parsed.scope,
        scopeResolver: spec.scopeResolver ?? null,
        conditions: (spec.conditions ?? {}) as never,
      },
    });
  }
  return role;
}

export async function booksTenant(slug: string, opts: { invoicePosting?: boolean } = {}): Promise<BooksTenant> {
  const tenant = await unscopedPrisma.tenant.upsert({
    where: { slug },
    create: { name: `Books fixture ${slug}`, slug, status: 'active' },
    update: {},
  });
  const tid = tenant.id;
  const entity =
    (await unscopedPrisma.ledgerEntity.findFirst({ where: { tenantId: tid, code: 'BOOKS' } })) ??
    (await unscopedPrisma.ledgerEntity.create({
      data: { tenantId: tid, code: 'BOOKS', legalName: `Books fixture ${slug}`, stateCode: '27' },
    }));
  // Invoice posting (Phase 0): the books tenant issues invoices, so it gets the posting setup
  // unless the suite maps its own posting roles at the same dates (then it opts out). Its one
  // entity is the one made above, so the fixture adds no second one.
  if (opts.invoicePosting !== false) await readyInvoicePosting(tid);
  const bank =
    (await unscopedPrisma.ledgerAccount.findFirst({
      where: { tenantId: tid, accountType: 'bank', deletedAt: null },
    })) ?? (await unscopedPrisma.ledgerAccount.create({ data: { tenantId: tid, name: 'Bank', accountType: 'bank' } }));
  const category =
    (await unscopedPrisma.ledgerCategory.findFirst({ where: { tenantId: tid } })) ??
    (await unscopedPrisma.ledgerCategory.create({ data: { tenantId: tid, name: 'Books fixture', kind: 'expense' } }));
  // The books' dated tables (retention policies, useful lives, IT blocks): the seed's own writer.
  await asSystem(tid, () => seedBooks());
  const organization =
    (await unscopedPrisma.organization.findFirst({
      where: { tenantId: tid, recordCode: `ORG-BOOKS-${slug.toUpperCase()}` },
    })) ??
    (await unscopedPrisma.organization.create({
      data: {
        tenantId: tid,
        recordCode: `ORG-BOOKS-${slug.toUpperCase()}`,
        kind: 'institution',
        name: `Books fixture ${slug}`,
      },
    }));
  const finance = await ensurePrincipalForRole(tid, slug, 'finance_head', `finance@${slug}.books.test`, 'Finance Head');
  const chairman = await ensurePrincipalForRole(tid, slug, 'chairman', `chairman@${slug}.books.test`, 'Chairman');
  invalidateGrantCache();
  return {
    tenantId: tid,
    entityId: entity.id,
    bankAccountId: bank.id,
    categoryId: category.id,
    organizationId: organization.id,
    finance,
    chairman,
  };
}

/**
 * Closes, in ascending month order, every month of the tenant that is not closed yet, up to
 * and including `month`. The proposer requests, the chairman approves. The order rule
 * refuses a close while an earlier month is open, so this walk is the only way to reach a
 * later month. A month with no row yet is created by its request, as the books do.
 */
export async function closeThrough(f: BooksTenant, month: string): Promise<string[]> {
  const pending = await unscopedPrisma.accountingPeriod.findMany({
    where: { tenantId: f.tenantId, period: { lte: month }, status: { not: 'closed' } },
    select: { period: true },
    orderBy: { period: 'asc' },
  });
  const months = [...new Set([...pending.map((r) => r.period), month])].sort();
  const closed: string[] = [];
  for (const period of months) {
    const row = await unscopedPrisma.accountingPeriod.findFirst({ where: { tenantId: f.tenantId, period } });
    if (row?.status === 'closed') continue;
    if (!row || row.status === 'open' || row.status === 'reopened') {
      await asUser(f.finance, () => requestClosePeriod(period));
    }
    await asUser(f.chairman, () => closePeriod(period));
    closed.push(period);
  }
  return closed;
}

/**
 * Reopens every closed month of the tenant, latest first: the order rule refuses a reopen
 * while a later month is closed or closing. Run at the end of a window, so the file's
 * writes into earlier months are postable again.
 */
export async function reopenLatestFirst(f: BooksTenant, reason: string): Promise<string[]> {
  const closed = await unscopedPrisma.accountingPeriod.findMany({
    where: { tenantId: f.tenantId, status: 'closed' },
    select: { period: true },
    orderBy: { period: 'desc' },
  });
  for (const { period } of closed) {
    await asUser(f.chairman, () => reopenPeriod(period, reason));
  }
  return closed.map((r) => r.period);
}

export { prisma, unscopedPrisma };
