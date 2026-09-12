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

  const [accounts, transactions, employees, organizations, invoices, users, imports] = await Promise.all([
    prisma.ledgerAccount.count({ where: { tenantId, deletedAt: null } }),
    prisma.transaction.count({ where: { tenantId, deletedAt: null } }),
    prisma.employmentRelationship.count({ where: { tenantId, deletedAt: null } }),
    prisma.organization.count({ where: { tenantId, deletedAt: null } }),
    prisma.invoice.count({ where: { tenantId } }),
    prisma.user.count({ where: { tenantId } }),
    prisma.importBatch.count({ where: { tenantId, status: 'committed' } }),
  ]);

  const all: OnboardingStep[] = [
    {
      key: 'books',
      title: 'Bring your books in',
      why:
        'A Tally export, or a bank statement. Until the platform knows what has actually happened, every figure it shows you is about nothing.',
      done: transactions > 0,
      count: transactions,
      path: '/data/import',
      action: 'Import a file',
      permission: 'imports:C',
    },
    {
      key: 'accounts',
      title: 'Check your accounts',
      why:
        'The bank accounts and cash boxes money sits in. An import creates these from the names in your file; look at them once and correct anything it got wrong.',
      done: accounts > 0,
      count: accounts,
      path: '/finance/ledger',
      action: 'Open the ledger',
      permission: 'ledger_accounts:V',
    },
    {
      key: 'people',
      title: 'Put your team on the books',
      why:
        'Leave, attendance, payroll and skills all hang off an employment record, so nothing in People works until the people are there.',
      done: employees > 0,
      count: employees,
      path: '/data/import',
      action: 'Import a staff list',
      permission: 'employees:C',
    },
    {
      key: 'customers',
      title: 'Add who you sell to',
      why: 'One record per real organisation, whether they are a client, a college, or both.',
      done: organizations > 0,
      count: organizations,
      path: '/crm/accounts',
      doPath: '/crm/accounts?new=1',
      action: 'Add a customer',
      permission: 'organizations:C',
    },
    {
      key: 'invoice',
      title: 'Raise an invoice',
      why: 'The other half of the money picture: what you are owed, beside what you have spent.',
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
      why:
        'Everyone signs in as themselves. An employee sees their own leave and payslip and nobody else’s; the Finance Head sees the books; HR runs the people function.',
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
