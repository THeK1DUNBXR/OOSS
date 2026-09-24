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
  nextTenantOnboardingState,
  tenantOnboardingStepFor,
  type TenantConfig,
  type TenantOnboardingEvent,
  type TenantOnboardingState,
  type TenantOnboardingStateRecord,
} from '@kaizen/shared';
import { prisma } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { can } from '../platform/permissions.js';

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

export function applyTenantOnboardingTransition(
  current: Partial<TenantOnboardingStateRecord> | null | undefined,
  event: TenantOnboardingEvent,
): TenantOnboardingStateRecord {
  const status = (current?.status ?? 'draft') as TenantOnboardingState;
  const nextStatus = nextTenantOnboardingState(status, event);
  const now = new Date().toISOString();

  return {
    status: nextStatus,
    step: tenantOnboardingStepFor(nextStatus),
    startedAt: current?.startedAt ?? now,
    updatedAt: now,
    completedAt: nextStatus === 'active' ? current?.completedAt ?? now : current?.completedAt,
    blockedReason: nextStatus === 'blocked' ? current?.blockedReason ?? 'Awaiting a required step.' : undefined,
  };
}

export async function tenantOnboardingState(): Promise<TenantOnboardingStateRecord> {
  const auth = currentAuth();

  const tenant = await prisma.tenant.findUnique({
    where: { id: auth.tenantId },
    select: { config: true },
  });

  const config = (tenant?.config as TenantConfig | null) ?? {};
  const saved = config.onboarding ?? {
    status: 'draft',
    step: 'Begin setup',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const companyProfileCount = await prisma.companyProfile.count({ where: { tenantId: auth.tenantId } });
  const ledgerAccountCount = await prisma.ledgerAccount.count({ where: { tenantId: auth.tenantId } });
  const importCount = await prisma.importBatch.count({ where: { tenantId: auth.tenantId, status: 'committed' } });

  let status: TenantOnboardingState = saved.status;
  if (status === 'draft' && companyProfileCount > 0) status = 'company_profile';
  if (status === 'company_profile' && ledgerAccountCount > 0) status = 'statutory_configured';
  if (status === 'statutory_configured' && importCount > 0) status = 'openings_imported';
  if (status === 'openings_imported' && companyProfileCount > 0 && ledgerAccountCount > 0) status = 'verified';
  if (status === 'verified' && importCount > 0) status = 'active';

  const next: TenantOnboardingStateRecord = {
    status,
    step: tenantOnboardingStepFor(status),
    startedAt: saved.startedAt ?? new Date().toISOString(),
    updatedAt: saved.updatedAt ?? new Date().toISOString(),
    completedAt: status === 'active' ? saved.completedAt ?? new Date().toISOString() : saved.completedAt,
  };

  await prisma.tenant.update({
    where: { id: auth.tenantId },
    data: { config: { ...config, onboarding: next } as never },
  });

  return next;
}
