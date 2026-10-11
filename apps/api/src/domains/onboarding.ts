/**
 * Getting a new company from an empty tenant to a working one.
 *
 * The platform stopped shipping a demonstration, which is right and which
 * leaves a real problem behind: the first thing a new company sees is eleven
 * empty screens, and nothing on any of them says which one to open first.
 *
 * So there is a checklist, and its steps are *computed from the data* rather
 * than ticked off by the user. A step is done when the thing it describes
 * exists. That matters more than it sounds: a checklist you tick yourself
 * drifts out of agreement with reality on the first day somebody deletes
 * something, and then it is lying to you about your own setup. This one cannot.
 *
 * The counts are also the honest answer to "is this thing set up", which the
 * dashboard, the tutorial and the empty states all want to know.
 */

import {
  EVENTS,
  resolveTenantOnboardingTransition,
  tenantOnboardingStepFor,
  type TenantOnboardingEvent,
  type TenantOnboardingState,
} from '@kaizen/shared';
import { prisma, type DbTx } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { assertCan, can } from '../platform/permissions.js';
import { auditWrite, registerGovernedEntities } from '../platform/audit.js';
import { governedWrite } from '../platform/governedWrite.js';
import { emit } from '../platform/eventBus.js';
import { ApiError } from '../platform/errors.js';

registerGovernedEntities('onboarding', ['tenant_onboarding_run']);

export interface OnboardingStep {
  key: string;
  title: string;
  /** What this gets you, in the user's terms rather than the model's. */
  why: string;
  done: boolean;
  /** How many of the thing exist. Shown so "done" is checkable. */
  count: number;
  /** Where to go to do it. */
  path: string;
  /**
   * Where the step is actually *performed*, when that differs from the screen
   * it lives on. Adding a customer happens in a dialog on the organisations
   * screen, so the button that says "Add a customer" opens that dialog rather
   * than dropping somebody on a list and leaving them to find it. Used only
   * while the step is undone; once it is done the plain screen is what you
   * want to look at.
   */
  doPath?: string;
  action: string;
  /** Hidden entirely from somebody who could not do it anyway. */
  permission: string;
  /** A step nobody has to do to be up and running. */
  optional?: boolean;
}

export interface OnboardingState {
  steps: OnboardingStep[];
  done: number;
  total: number;
  /** True once every required step is done. */
  complete: boolean;
}

export async function onboardingState(): Promise<OnboardingState> {
  const auth = currentAuth();
  const tenantId = auth.tenantId;

  const [accounts, transactions, employees, students, institutions, invoices, users, imports] = await Promise.all([
    prisma.ledgerAccount.count({ where: { tenantId, deletedAt: null } }),
    prisma.transaction.count({ where: { tenantId, deletedAt: null } }),
    prisma.employmentRelationship.count({ where: { tenantId, deletedAt: null } }),
    prisma.studentProfile.count({ where: { tenantId, deletedAt: null } }),
    prisma.organization.count({ where: { tenantId, kind: 'institution', deletedAt: null } }),
    prisma.invoice.count({ where: { tenantId } }),
    prisma.user.count({ where: { tenantId } }),
    prisma.importBatch.count({ where: { tenantId, status: 'committed' } }),
  ]);

  const all: OnboardingStep[] = [
    {
      key: 'books',
      title: 'Bring your books in',
      why: 'A Tally export or a bank statement. Every figure on every screen comes from this.',
      done: transactions > 0,
      count: transactions,
      path: '/data/import',
      action: 'Import a file',
      permission: 'imports:C',
    },
    {
      key: 'accounts',
      title: 'Check your accounts',
      why: 'The bank accounts and cash boxes money sits in. An import creates these \u2014 check them once.',
      done: accounts > 0,
      count: accounts,
      path: '/finance/ledger',
      action: 'Open the ledger',
      permission: 'ledger_accounts:V',
    },
    {
      key: 'people',
      title: 'Put your team on the books',
      why: 'Leave, attendance, payroll and skills all need an employment record first.',
      done: employees > 0,
      count: employees,
      path: '/data/import',
      action: 'Import a staff list',
      permission: 'employees:C',
    },
    {
      key: 'students',
      title: 'Add your students',
      why: 'The learners you teach. One record each, and most invoices are addressed to them.',
      done: students > 0,
      count: students,
      path: '/crm/students',
      doPath: '/crm/students?new=1',
      action: 'Add a student',
      permission: 'students:C',
    },
    {
      key: 'institutions',
      title: 'Add the institutions you work with',
      why: 'The colleges learners come to you from. Each one then shows how many it sent and how they did.',
      done: institutions > 0,
      count: institutions,
      path: '/crm/institutions',
      doPath: '/crm/institutions?new=1',
      action: 'Add a college',
      permission: 'institutions:C',
      optional: true,
    },
    {
      key: 'invoice',
      title: 'Raise an invoice',
      why: 'What you are owed, beside what you have spent.',
      done: invoices > 0,
      count: invoices,
      path: '/finance/invoices',
      action: 'Raise one',
      permission: 'invoices:C',
      optional: true,
    },
    {
      key: 'team',
      title: 'Give your colleagues accounts',
      why: 'Everyone signs in as themselves and sees only what their job needs.',
      done: users > 1,
      count: users,
      path: '/admin/governance',
      action: 'Manage access',
      permission: 'users:C',
      optional: true,
    },
  ];

  // Steps somebody could not perform are not shown to them. An employee
  // opening this should see an empty checklist rather than six things they are
  // not allowed to do.
  const visible: OnboardingStep[] = [];
  for (const step of all) {
    const [resource, letter] = step.permission.split(':');
    const verb = letter === 'C' ? 'create' : 'view';
    if (await can({ resource, verb: verb as 'create' | 'view' })) visible.push(step);
  }

  const required = visible.filter((s) => !s.optional);
  return {
    steps: visible,
    done: visible.filter((s) => s.done).length,
    total: visible.length,
    // Imports alone can satisfy the first three, which is the intended path:
    // one Tally export and one staff list and the company is running.
    complete: required.length > 0 && required.every((s) => s.done),
  };
}

/** Whether this tenant has ever had anything imported — used by empty states. */
export async function hasImported(): Promise<boolean> {
  const auth = currentAuth();
  return (await prisma.importBatch.count({ where: { tenantId: auth.tenantId, status: 'committed' } })) > 0;
}

export interface TenantOnboardingRunView {
  /** Null while the tenant has no run row. Such a tenant has never been advanced, and reads as draft. */
  id: string | null;
  state: TenantOnboardingState;
  revision: number;
  /** Where a blocked run resumes to. Null unless the run is blocked. */
  blockedFrom: TenantOnboardingState | null;
  step: string;
}

/**
 * What the six-state preconditions count. These are the rows the write-on-read
 * this replaces counted (a company profile, a ledger account, a committed
 * import), so a tenant moves on the evidence it always had. A ledger account
 * that has been deleted is not evidence: onboardingState above already treats
 * it that way.
 */
interface SetUpFacts {
  profile: boolean;
  ledger: boolean;
  imported: boolean;
}

async function setUpFacts(tenantId: string): Promise<SetUpFacts> {
  const [profiles, ledgers, imports] = await Promise.all([
    prisma.companyProfile.count({ where: { tenantId } }),
    prisma.ledgerAccount.count({ where: { tenantId, deletedAt: null } }),
    prisma.importBatch.count({ where: { tenantId, status: 'committed' } }),
  ]);
  return { profile: profiles > 0, ledger: ledgers > 0, imported: imports > 0 };
}

/**
 * What a move into a state needs to be true first, each condition named the way
 * the 422 will say it. A move that does not check these would let a run say a
 * step is done when the thing it describes does not exist: the same lie the
 * checklist is built to avoid.
 */
const PRECONDITIONS: Partial<
  Record<TenantOnboardingState, Array<{ holds: (f: SetUpFacts) => boolean; unmet: string }>>
> = {
  company_profile: [{ holds: (f) => f.profile, unmet: 'the company profile has not been saved' }],
  statutory_configured: [{ holds: (f) => f.ledger, unmet: 'no ledger account exists yet' }],
  openings_imported: [{ holds: (f) => f.imported, unmet: 'no committed import exists yet' }],
  verified: [
    { holds: (f) => f.profile, unmet: 'the company profile has not been saved' },
    { holds: (f) => f.ledger, unmet: 'no ledger account exists yet' },
  ],
  active: [{ holds: (f) => f.imported, unmet: 'no committed import exists yet' }],
};

/** The event a move into a state publishes. RESUME has its own, whatever state it returns to. */
const EVENT_FOR_TARGET: Partial<Record<TenantOnboardingState, string>> = {
  company_profile: EVENTS.ONBOARDING_COMPANY_PROFILE_RECORDED,
  statutory_configured: EVENTS.ONBOARDING_STATUTORY_CONFIGURED,
  openings_imported: EVENTS.ONBOARDING_OPENINGS_IMPORTED,
  verified: EVENTS.ONBOARDING_VERIFIED,
  active: EVENTS.ONBOARDING_ACTIVATED,
  blocked: EVENTS.ONBOARDING_BLOCKED,
};

function eventNameFor(event: TenantOnboardingEvent, to: TenantOnboardingState): string {
  if (event === 'RESUME') return EVENTS.ONBOARDING_RESUMED;
  const name = EVENT_FOR_TARGET[to];
  if (name === undefined) throw ApiError.internal(`No onboarding event is named for the state ${to}.`);
  return name;
}

async function blockedFromOf(tenantId: string, runId: string): Promise<TenantOnboardingState | null> {
  // The latest move into `blocked` is the block the run is in now: a blocked run cannot be blocked again.
  const last = await prisma.onboardingTransition.findFirst({
    where: { tenantId, runId, toState: 'blocked' },
    orderBy: { revision: 'desc' },
  });
  return last ? (last.fromState as TenantOnboardingState) : null;
}

function viewOf(
  row: { id: string; state: string; revision: number } | null,
  blockedFrom: TenantOnboardingState | null,
): TenantOnboardingRunView {
  const state = (row?.state ?? 'draft') as TenantOnboardingState;
  return {
    id: row?.id ?? null,
    state,
    revision: row?.revision ?? 0,
    blockedFrom: state === 'blocked' ? blockedFrom : null,
    step: tenantOnboardingStepFor(state),
  };
}

/**
 * Where the tenant is in setup. A read: it writes nothing, and a tenant with no
 * run row reads as draft without one being created.
 *
 * This used to be a write on read (tenantOnboardingState, which rewrote
 * Tenant.config.onboarding on every call, and walked the state forward several
 * steps at once). A GET should not change what it reports, and a state that moves
 * on a read cannot be audited, so the state now moves only through advanceOnboarding.
 */
export async function tenantOnboardingRun(): Promise<TenantOnboardingRunView> {
  await assertCan({ resource: 'company_profile', verb: 'view' });
  const tenantId = currentAuth().tenantId;
  const row = await prisma.tenantOnboardingRun.findUnique({ where: { tenantId } });
  const blockedFrom = row && row.state === 'blocked' ? await blockedFromOf(tenantId, row.id) : null;
  return viewOf(row, blockedFrom);
}

/**
 * Applies exactly one transition to the run. It never cascades: a tenant whose
 * data satisfies three steps still moves one step per call, so the history shows
 * each step a person took, and the audit row and event for each say what was done.
 *
 * The caller names the state it read (`fromState`). The update matches on that
 * state, so a concurrent advance, or a stale screen, gets a 409 and leaves the run
 * where the other change put it. A move the table does not allow is a 409; a move
 * whose evidence is missing is a 422 that says which evidence.
 */
export async function advanceOnboarding(input: {
  event: TenantOnboardingEvent;
  fromState: TenantOnboardingState;
}): Promise<TenantOnboardingRunView> {
  await assertCan({ resource: 'company_profile', verb: 'edit' });
  const auth = currentAuth();
  const tenantId = auth.tenantId;
  const { event, fromState } = input;

  const current = await prisma.tenantOnboardingRun.findUnique({ where: { tenantId } });
  const blockedFrom = event === 'RESUME' && current ? await blockedFromOf(tenantId, current.id) : null;
  const to = resolveTenantOnboardingTransition(fromState, event, blockedFrom ?? undefined);
  if (to === undefined) {
    throw ApiError.conflict(`A run at ${fromState} cannot take ${event}.`, { from: fromState, event });
  }

  if (event !== 'RESUME' && PRECONDITIONS[to]) {
    const facts = await setUpFacts(tenantId);
    const unmet = PRECONDITIONS[to]!.filter((c) => !c.holds(facts)).map((c) => c.unmet);
    if (unmet.length > 0) {
      throw ApiError.unprocessable(`Cannot move onboarding to ${to}: ${unmet.join('; ')}.`, { missing: unmet, to });
    }
  }

  const row = await governedWrite(async (tx: DbTx) => {
    // A tenant with no run is a draft. The row is created inside the transaction, so
    // a move refused below leaves no row behind. Two first advances race on the unique
    // tenantId; the loser's createMany is a no-op, and its update then matches nothing.
    await tx.tenantOnboardingRun.createMany({ data: { tenantId, state: 'draft', revision: 0 }, skipDuplicates: true });

    const { count } = await tx.tenantOnboardingRun.updateMany({
      where: { tenantId, state: fromState },
      data: { state: to, revision: { increment: 1 } },
    });
    if (count !== 1) {
      throw ApiError.conflict('The onboarding run changed while this was being recorded. Reload it and try again.', {
        from: fromState,
      });
    }

    const after = await tx.tenantOnboardingRun.findUniqueOrThrow({ where: { tenantId } });
    await tx.onboardingTransition.create({
      data: {
        tenantId,
        runId: after.id,
        event,
        fromState,
        toState: to,
        revision: after.revision,
        actorPartyId: auth.partyId ?? null,
      },
    });
    await auditWrite({
      action: 'update',
      subjectType: 'tenant_onboarding_run',
      subjectId: after.id,
      before: { state: fromState },
      after: { state: to, revision: after.revision },
      tx,
    });
    await emit({
      name: eventNameFor(event, to),
      subject: { entityType: 'tenant_onboarding_run', entityId: after.id },
      previousState: { state: fromState },
      newState: { state: to },
      tx,
    });
    return after;
  });

  return viewOf(row, to === 'blocked' ? fromState : null);
}
