/**
 * The getting-started checklist, and the banner that carries its next step
 * around the rest of the app.
 *
 * The bug these were written for: the banner was a single link wrapped around
 * the whole strip, so its button — labelled with the step's own action, "Add a
 * customer" — went to the checklist the strip was already summarising. Nothing
 * threw, nothing logged, every unit test passed; the button simply did not do
 * what it said. That is the shape of defect this file exists to catch, so the
 * assertions are about the promise a label makes and whether the link under it
 * keeps that promise.
 *
 * The rule, from `destinationOf`: an undone step is a job, so its button goes
 * where the job is done; a done step is something to look at, so its button
 * goes to the screen.
 */

import { expect, test } from '@playwright/test';
import {
  destinationOf,
  onboardingState,
  pathOf,
  signIn,
  type OnboardingState,
  type OnboardingStep,
} from './helpers.js';

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test.describe('the getting-started checklist', () => {
  test('every step button points where its own label says', async ({ page, request }) => {
    const state = await onboardingState(request);
    test.skip(state.steps.length === 0, 'this account has no setup steps of its own');

    await page.goto('/start');

    for (const step of state.steps) {
      const row = page.getByRole('listitem').filter({ hasText: step.title });
      const link = row.getByRole('link');

      // The words on the button are the promise; the href is whether it is kept.
      await expect(link, `the "${step.title}" step has no button`).toHaveCount(1);
      await expect(link).toHaveText(step.done ? 'Open' : step.action);
      await expect(link).toHaveAttribute('href', destinationOf(step));
    }
  });

  test('every step button arrives at a real screen', async ({ page, request }) => {
    const state = await onboardingState(request);
    test.skip(state.steps.length === 0, 'this account has no setup steps of its own');

    await page.goto('/start');

    for (const step of state.steps) {
      await page.getByRole('listitem').filter({ hasText: step.title }).getByRole('link').click();

      // An unrouted path does not 404 here — the client's catch-all sends it
      // quietly back to the landing screen — so landing anywhere other than the
      // named path means the step points at a screen that does not exist.
      await expect
        .poll(() => pathOf(page.url()), { message: `the "${step.title}" step went somewhere else` })
        .toBe(pathOf(destinationOf(step)));

      // Back through the sidebar rather than by reloading: the checklist is one
      // click away from everywhere, and a full page load per step turns this
      // into a minute of waiting for the browser rather than a test.
      await page.getByRole('link', { name: 'Getting Started' }).click();
      await expect.poll(() => pathOf(page.url())).toBe('/start');
    }
  });
});

test.describe('the setup banner', () => {
  /**
   * The banner only exists while setup is unfinished, and a working company's
   * is finished — so the checklist the client is handed is edited on the way in
   * to put one step back to undone. Everything under test is on the client side
   * of that response, and this is the state a company is in on its first day.
   */
  async function withUnfinishedSetup(
    page: import('@playwright/test').Page,
    key: string,
  ): Promise<void> {
    await page.route('**/api/auth/onboarding', async (route) => {
      const response = await route.fetch();
      const state = (await response.json()) as OnboardingState;
      for (const step of state.steps) if (step.key === key) step.done = false;
      state.done = state.steps.filter((s) => s.done).length;
      state.complete = false;
      await route.fulfill({ response, json: state });
    });
  }

  async function nextStep(request: import('@playwright/test').APIRequestContext, key: string): Promise<OnboardingStep> {
    const state = await onboardingState(request);
    const step = state.steps.find((s) => s.key === key);
    expect(step, `no "${key}" step for this account`).toBeTruthy();
    return { ...step!, done: false };
  }

  test('the words lead to the checklist and the button does the job', async ({ page, request }) => {
    const step = await nextStep(request, 'customers');
    await withUnfinishedSetup(page, 'customers');
    await page.goto('/command');

    const banner = page.getByRole('link', { name: new RegExp(`Next: ${step.title}`) });
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute('href', '/start');

    // The regression: this used to be a span inside the banner's own link, so
    // it went to /start like everything else on the strip.
    const action = page.getByRole('link', { name: step.action, exact: true });
    await expect(action).toBeVisible();
    await expect(action).toHaveAttribute('href', destinationOf(step));

    await action.click();
    await expect.poll(() => pathOf(page.url())).toBe(pathOf(destinationOf(step)));
  });

  test('"Add a customer" arrives with the form open', async ({ page }) => {
    await withUnfinishedSetup(page, 'customers');
    await page.goto('/command');
    await page.getByRole('link', { name: 'Add a customer', exact: true }).click();

    // Landing on a list of the customers you already have is not adding one.
    await expect(page.getByRole('heading', { name: /add a company or a college/i })).toBeVisible();

    // And the parameter that opened it is spent: a reload should not reopen the
    // form, and Back should return to the list rather than to the same screen.
    await expect.poll(() => new URL(page.url()).search).toBe('');
  });
});
