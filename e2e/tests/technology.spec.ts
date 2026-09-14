/**
 * Technology (docs/plan/cio.md) — a smoke test, in the style of
 * `setup-checklist.spec.ts`: not a test of any one workstream's business
 * logic (each workstream's own vitest suite does that), but a check that the
 * Technology sidebar group, its nav entries and its screens exist, render,
 * and stay off the grant matrix cells that withhold them.
 *
 * The Technology group is collapsed by default (`Shell.tsx`,
 * `COLLAPSED_BY_DEFAULT`), so every test here opens it before looking for a
 * link inside it.
 */

import { expect, test, type Page } from '@playwright/test';

/** Every Technology nav entry (`apps/api/src/seed/bootstrap.ts`, `group:
 *  'technology'`), label as seeded. Kept in sync by hand rather than read
 *  from the server, the same way `helpers.ts` keeps `credentials()` by
 *  hand — this is the fixed list the grant matrix and the sidebar are both
 *  being held to. */
const TECHNOLOGY_NAV_LABELS = [
  'Technology',
  'My IT',
  'Assets',
  'Applications',
  'Licences',
  'Vendors',
  'Vendor Contracts',
  'Service Desk',
  'Knowledge Base',
  'Incidents',
  'Problems',
  'Changes',
  'Risks',
  'Policies',
  'Controls',
  'Access Reviews',
  'Security Findings',
  'Portfolio',
  'Roadmap',
  'Technology Budget',
  'Technical Debt',
  'Continuity',
];

async function dismissIntro(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('kaizen.seenIntro', '1');
    } catch {
      /* a browser without storage still shows the modal; nothing to do */
    }
  });
}

async function signInAs(page: Page, email: string, password: string): Promise<void> {
  await dismissIntro(page);
  await page.goto('/');
  await page.locator('input[type=email]').fill(email);
  await page.locator('input[type=password]').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('link', { name: 'Getting Started' })).toBeVisible();
}

function chairmanCredentials(): { email: string; password: string } {
  const email = process.env.E2E_EMAIL ?? process.env.OWNER_EMAIL;
  const password = process.env.E2E_PASSWORD ?? process.env.OWNER_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'These tests sign in as the chairman. Set E2E_EMAIL and E2E_PASSWORD (or OWNER_EMAIL and ' +
        'OWNER_PASSWORD, the names the seed reads) to the chairman account on the running stack.',
    );
  }
  return { email, password };
}

/** The employee account has no `E2E_EMAIL`-style override — `helpers.ts`
 *  never needed one — so this reads the seed's own env names directly, the
 *  same way `credentials()` reads `OWNER_EMAIL`/`OWNER_PASSWORD`. `null`
 *  when neither is set, so the employee test can skip cleanly rather than
 *  fail on a stack where nobody exported it. */
function employeeCredentials(): { email: string; password: string } | null {
  const email = process.env.E2E_EMPLOYEE_EMAIL ?? process.env.EMPLOYEE_EMAIL;
  const password = process.env.E2E_EMPLOYEE_PASSWORD ?? process.env.EMPLOYEE_PASSWORD;
  if (!email || !password) return null;
  return { email, password };
}

/** Opens the collapsed Technology sidebar group, if it is not already open —
 *  a screen inside the group opens it on its own (`Shell.tsx`, `holdsCurrent`). */
async function openTechnologyGroup(page: Page): Promise<void> {
  const toggle = page.getByRole('button', { name: 'Technology' });
  if (await toggle.count()) {
    const expanded = await toggle.getAttribute('aria-expanded');
    if (expanded === 'false') await toggle.click();
  }
}

test.describe('the Technology group, signed in as the chairman', () => {
  test.beforeEach(async ({ page }) => {
    const { email, password } = chairmanCredentials();
    await signInAs(page, email, password);
    await openTechnologyGroup(page);
  });

  test('every Technology nav entry is present', async ({ page }) => {
    for (const label of TECHNOLOGY_NAV_LABELS) {
      await expect(page.getByRole('link', { name: label, exact: true }), `no "${label}" link in the sidebar`).toBeVisible();
    }
  });

  test('the core Technology screens render a header with no error box', async ({ page }) => {
    const screens = ['/it', '/it/assets', '/it/tickets', '/it/incidents', '/it/risks', '/it/portfolio', '/it/continuity'];

    for (const path of screens) {
      await page.goto(path);
      await expect(page.locator('h1'), `${path} rendered no page header`).toBeVisible();
      // `ErrorBox` (apps/web/src/components/ui.tsx) always wears this class,
      // whatever the error message says, so this is sturdier than matching text.
      await expect(page.locator('[class*="border-band-critical"]'), `${path} rendered an error box`).toHaveCount(0);
    }
  });
});

test.describe('the Technology group, signed in as an employee', () => {
  test.beforeEach(async ({ page }) => {
    const creds = employeeCredentials();
    test.skip(!creds, 'set E2E_EMPLOYEE_EMAIL and E2E_EMPLOYEE_PASSWORD (or EMPLOYEE_EMAIL/EMPLOYEE_PASSWORD) to run this');
    await signInAs(page, creds!.email, creds!.password);
  });

  test('the desk, licences and risks are withheld; My IT and the catalogue are not', async ({ page }) => {
    await openTechnologyGroup(page);

    await expect(page.getByRole('link', { name: 'Service Desk', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Licences', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Risks', exact: true })).toHaveCount(0);

    await expect(page.getByRole('link', { name: 'My IT', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Applications', exact: true })).toBeVisible();
  });
});
